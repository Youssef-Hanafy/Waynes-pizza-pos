import "server-only";

import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { getWorkspaceStoreSettings } from "@/lib/content/queries";
import { getHardwareSettings } from "@/lib/hardware/queries";
import { recordDeviceEvents } from "@/lib/pos/device-events";
import { getPosStripeReaderEnabled } from "./queries";
import { stripeSecrets } from "./capabilities";
import { readPaymentConnection } from "./config";
import { PaymentProviderError, type LedgerStatus } from "./provider";
import { mapTerminalIntent, type StripeTerminalIntent, type TerminalIntentResult } from "./stripe-terminal-mapping";

/**
 * Stripe Reader M2 at the counter (owner, 2026-09-30).
 *
 * The M2 is a Bluetooth reader: it only talks to Stripe's Android SDK, which
 * runs inside the POS Android app.  The app does the card part (discover,
 * connect, "tap / insert / swipe"); everything with the secret key happens
 * here, on the server:
 *
 *   connection token   lets the app's SDK talk to Stripe for this account
 *   terminal location  the Stripe "Location" the reader registers to (made once, automatically)
 *   payment intent     one per order payment, card_present, captured automatically
 *   confirm / cancel   re-read Stripe and settle the ledger; the browser is never trusted
 *
 * It uses the store's existing Stripe account (the one online checkout uses,
 * env:STRIPE on the server) and is switched on per store in Admin → Hardware
 * → Payment terminal ("Stripe Reader M2").
 */

export type StripeTerminalAccount = { secretKey: string; workspaceId: string; locationId: string | null; environment: "sandbox" | "production" };

type Guarded = { ok: true; account: StripeTerminalAccount } | { ok: false; response: Response };

const noStore = { "Cache-Control": "no-store" };
export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: noStore });

/** Staff, same-origin, Stripe connected and the M2 switched on — or the reason why not. */
export async function guardStripeTerminal(request: Request): Promise<Guarded> {
  const result = await checkStripeTerminal(request);
  if (!result.ok) {
    const access = await getCurrentAccess().catch(() => null);
    const body = await result.response.clone().json().catch(() => ({})) as { error?: string };
    if (access?.workspace_id) await recordDeviceEvents(
      { workspaceId: access.workspace_id, profileId: access.profile_id, userAgent: request.headers.get("user-agent"), source: "server" },
      [{ kind: "server.terminal_refused", message: body.error ?? "", detail: { path: new URL(request.url).pathname, status: result.response.status } }],
    );
  }
  return result;
}

async function checkStripeTerminal(request: Request): Promise<Guarded> {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access") || !access?.workspace_id) return { ok: false, response: json({ error: "POS access required." }, 403) };
  if (request.headers.get("origin") !== new URL(request.url).origin) return { ok: false, response: json({ error: "Invalid request origin." }, 403) };

  const scopeIds = { workspace_id: access.workspace_id, location_id: access.location_id ?? null };
  const [{ settings }, readerEnabled] = await Promise.all([getHardwareSettings(scopeIds), getPosStripeReaderEnabled(scopeIds)]);
  // Same rule as the POS page: either switch turns the M2 on, so the screen and the server never disagree.
  if (settings.payment_terminal_mode !== "integrated" && !readerEnabled)
    return { ok: false, response: json({ error: "The Stripe card reader is switched off. Turn it on in Admin → Hardware → Payment terminal." }, 503) };

  const scope = { workspaceId: access.workspace_id, locationId: access.location_id ?? null };
  const candidates = await Promise.all([readPaymentConnection("online", scope), readPaymentConnection("counter", scope)]);
  const connection = candidates.find((candidate) => candidate?.provider === "stripe" && !["disabled", "error", "not_configured"].includes(candidate.status));
  if (!connection) return { ok: false, response: json({ error: "Stripe is not connected for this store, so the card reader can't take payments." }, 503) };
  const secrets = stripeSecrets(connection.secret_reference);
  if (!secrets) return { ok: false, response: json({ error: "The server is missing the Stripe keys (STRIPE_SECRET_KEY)." }, 503) };

  return { ok: true, account: { secretKey: secrets.secretKey, workspaceId: access.workspace_id, locationId: access.location_id ?? null, environment: connection.environment } };
}

/** A Stripe Terminal step failed on the server: keep Stripe's own error code for the diagnostics log. */
export async function recordTerminalFailure(account: StripeTerminalAccount, request: Request, kind: string, cause: unknown) {
  const error = cause as { message?: string; code?: string };
  await recordDeviceEvents(
    { workspaceId: account.workspaceId, userAgent: request.headers.get("user-agent"), source: "server" },
    [{ kind, message: error?.message ?? String(cause), detail: { code: error?.code ?? null, environment: account.environment } }],
  );
}

function form(data: Record<string, string | number | boolean | null | undefined>) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) if (value !== null && value !== undefined && value !== "") body.set(key, String(value));
  return body;
}

async function stripe<T>(account: StripeTerminalAccount, path: string, init: { method: "GET" | "POST"; body?: URLSearchParams; idempotencyKey?: string }, fallback: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.stripe.com${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${account.secretKey}`,
        ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
      },
      body: init.body,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new PaymentProviderError("Stripe did not answer. Check the internet connection before trying again.", "NETWORK", true);
  }
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const error = (body as { error?: { code?: string; type?: string } } | null)?.error;
    throw new PaymentProviderError(fallback, error?.code ?? error?.type ?? "STRIPE_ERROR", response.status === 429 || response.status >= 500);
  }
  return body as T;
}

/** A short-lived secret the SDK in the app uses to reach Stripe. Never cached. */
export async function createConnectionToken(account: StripeTerminalAccount) {
  const token = await stripe<{ secret?: string }>(account, "/v1/terminal/connection_tokens", { method: "POST", body: form({}) }, "The card reader could not be authorised.");
  if (!token.secret) throw new PaymentProviderError("Stripe returned an empty connection token.", "INVALID_RESPONSE");
  return token.secret;
}

type StripeLocation = { id: string; metadata?: Record<string, string> };
const locationCache = new Map<string, string>();

/**
 * The Stripe Terminal Location a Bluetooth reader registers to.  Found by
 * the workspace id in its metadata, or created once from the store address in
 * Admin → Settings — nobody has to set it up in the Stripe dashboard.
 */
export async function ensureTerminalLocation(account: StripeTerminalAccount) {
  const cacheKey = `${account.environment}:${account.workspaceId}`;
  const cached = locationCache.get(cacheKey);
  if (cached) return cached;
  const list = await stripe<{ data?: StripeLocation[] }>(account, "/v1/terminal/locations?limit=100", { method: "GET" }, "The card reader's store location could not be read from Stripe.");
  const existing = list.data?.find((location) => location.metadata?.hanafy_workspace_id === account.workspaceId);
  if (existing) { locationCache.set(cacheKey, existing.id); return existing.id; }

  const store = await getWorkspaceStoreSettings();
  if (!store.address_line1.trim() || !store.city.trim() || !store.state.trim() || !store.postal_code.trim())
    throw new PaymentProviderError("Add the store's street address in Admin → Settings first — Stripe needs it to register the card reader.", "NO_ADDRESS");
  const created = await stripe<StripeLocation>(account, "/v1/terminal/locations", {
    method: "POST",
    idempotencyKey: `hanafy-terminal-location-${account.workspaceId}`,
    body: form({
      display_name: (store.store_name.trim() || "Store").slice(0, 100),
      "address[line1]": store.address_line1.trim(),
      "address[line2]": store.address_line2.trim(),
      "address[city]": store.city.trim(),
      "address[state]": store.state.trim(),
      "address[postal_code]": store.postal_code.trim(),
      "address[country]": "US",
      "metadata[hanafy_workspace_id]": account.workspaceId,
    }),
  }, "Stripe could not register the store location for the card reader.");
  locationCache.set(cacheKey, created.id);
  return created.id;
}

/** One card-present PaymentIntent per order payment; retries reuse it (never a second authorisation). */
export async function createTerminalIntent(account: StripeTerminalAccount, input: { amountCents: number; idempotencyKey: string; orderNumber: string; paymentId: string; description: string }): Promise<TerminalIntentResult> {
  const intent = await stripe<StripeTerminalIntent>(account, "/v1/payment_intents", {
    method: "POST",
    idempotencyKey: input.idempotencyKey,
    body: form({
      amount: input.amountCents,
      currency: "usd",
      "payment_method_types[]": "card_present",
      capture_method: "automatic",
      description: input.description.slice(0, 500),
      "metadata[wayne_payment_id]": input.paymentId,
      "metadata[wayne_order_number]": input.orderNumber,
      "metadata[wayne_entry]": "terminal",
      "metadata[hanafy_workspace_id]": account.workspaceId,
    }),
  }, "The payment could not be prepared on Stripe.");
  return mapTerminalIntent(intent);
}

export async function readTerminalIntent(account: StripeTerminalAccount, intentId: string): Promise<TerminalIntentResult> {
  const intent = await stripe<StripeTerminalIntent>(account, `/v1/payment_intents/${encodeURIComponent(intentId)}?expand[]=latest_charge`, { method: "GET" }, "The payment status could not be read from Stripe.");
  return mapTerminalIntent(intent);
}

export async function cancelTerminalIntent(account: StripeTerminalAccount, intentId: string): Promise<TerminalIntentResult> {
  const intent = await stripe<StripeTerminalIntent>(account, `/v1/payment_intents/${encodeURIComponent(intentId)}/cancel`, { method: "POST", body: form({ cancellation_reason: "abandoned" }) }, "The payment could not be cancelled on Stripe.");
  return mapTerminalIntent(intent);
}

/** The ledger status a settled intent is recorded as (null = still open on the reader). */
export function ledgerStatusFor(result: TerminalIntentResult): LedgerStatus | null {
  if (result.state === "captured") return "captured";
  if (result.state === "authorized") return "authorized";
  if (result.state === "canceled") return "voided";
  return null;
}
