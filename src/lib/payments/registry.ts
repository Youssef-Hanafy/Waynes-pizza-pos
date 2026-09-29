import "server-only";

import { capabilityGate, providerSecrets, squarePublicConfig, stripeSecrets, type PaymentCapabilities, type PaymentChannel, type PaymentConnection } from "./capabilities";
import type { PaymentProvider } from "./provider";
import { createSquareProvider, squareApiBase, SQUARE_API_VERSION } from "./square";
import { applySquareWebhookEvent, type ServiceClient } from "./square-webhook";
import { createStripeProvider } from "./stripe";
import { applyStripeWebhookEvent } from "./stripe-webhook";

/**
 * Provider adapter registry (Phase 9, §20.4/20.5).  The only place that maps
 * a connection's provider code to code that talks to a processor.  Routes and
 * order code receive a PaymentProvider (the interface) and never branch on
 * the provider.  A provider with no factory here is simply not available —
 * nothing is faked.
 */
export type PaymentProviderAdapter = {
  connection: PaymentConnection;
  getCapabilities(): PaymentCapabilities;
  provider: PaymentProvider;
};

type Factory = (connection: PaymentConnection) => PaymentProvider | null;

const factories: Record<string, Factory> = {
  square(connection) {
    const secrets = providerSecrets(connection.secret_reference);
    const config = squarePublicConfig(connection);
    if (!secrets || !config.applicationId || !config.locationId) return null;
    return createSquareProvider({
      accessToken: secrets.accessToken,
      webhookSignatureKey: secrets.webhookSignatureKey,
      environment: connection.environment,
      applicationId: config.applicationId,
      locationId: config.locationId,
      notificationUrl: config.notificationUrl,
    });
  },
  stripe(connection) {
    const secrets = stripeSecrets(connection.secret_reference);
    if (!secrets) return null;
    return createStripeProvider(secrets);
  },
  // manual_external deliberately has no factory: a person runs the store's
  // own terminal and confirms; the POS never calls the processor.
};

export function buildPaymentAdapter(connection: PaymentConnection, channel: PaymentChannel):
  { ok: true; value: PaymentProviderAdapter } | { ok: false; reason: string; manual?: true } {
  const gate = capabilityGate(connection, channel);
  if (!gate.ok) return gate;
  const factory = factories[connection.provider];
  if (!factory) return { ok: false, reason: "That payment provider is not available yet." };
  const provider = factory(connection);
  if (!provider) return { ok: false, reason: "The processor credentials are not installed on the server." };
  return { ok: true, value: { connection, provider, getCapabilities: () => connection.capabilities } };
}

/** The webhook receiver needs the provider even when payment switches are off. */
export function buildWebhookProvider(connection: PaymentConnection): PaymentProvider | null {
  if (!connection.capabilities.webhooks) return null;
  const factory = factories[connection.provider];
  return factory ? factory(connection) : null;
}

/**
 * A real, read-only call to the provider with the connection's own
 * credentials.  Only a success here may mark a connection "connected".
 */
export async function testPaymentConnection(connection: PaymentConnection): Promise<{ ok: boolean; note: string }> {
  if (connection.provider === "square") {
    const secrets = providerSecrets(connection.secret_reference);
    const { locationId } = squarePublicConfig(connection);
    if (!secrets) return { ok: false, note: `Server is missing the secrets named by ${connection.secret_reference ?? "(no reference)"}.` };
    if (!locationId) return { ok: false, note: "No Square location id on the connection." };
    try {
      const response = await fetch(`${squareApiBase(connection.environment)}/v2/locations/${encodeURIComponent(locationId)}`, {
        headers: { authorization: `Bearer ${secrets.accessToken}`, "square-version": SQUARE_API_VERSION, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { ok: false, note: `Square answered HTTP ${response.status} for location ${locationId}.` };
      const body = (await response.json()) as { location?: { status?: string; name?: string } };
      if (body.location?.status !== "ACTIVE") return { ok: false, note: `Square location ${locationId} is not active.` };
      return { ok: true, note: `Square location "${body.location.name ?? locationId}" is active (${connection.environment}).` };
    } catch (cause) {
      return { ok: false, note: `Square could not be reached: ${cause instanceof Error ? cause.message : "network error"}` };
    }
  }
  if (connection.provider === "stripe") {
    const secrets = stripeSecrets(connection.secret_reference);
    if (!secrets) return { ok: false, note: `Server is missing the Stripe credentials named by ${connection.secret_reference ?? "(no reference)"}.` };
    try {
      const response = await fetch("https://api.stripe.com/v1/account", {
        headers: { authorization: `Bearer ${secrets.secretKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return { ok: false, note: `Stripe answered HTTP ${response.status} while checking the account.` };
      const body = (await response.json()) as { business_profile?: { name?: string | null }; display_name?: string | null; charges_enabled?: boolean };
      if (!body.charges_enabled) return { ok: false, note: "Stripe accepted the key, but this account is not enabled to accept live charges yet." };
      return { ok: true, note: `Stripe account \"${body.business_profile?.name ?? body.display_name ?? "connected account"}\" can accept charges (${connection.environment}).` };
    } catch (cause) {
      return { ok: false, note: `Stripe could not be reached: ${cause instanceof Error ? cause.message : "network error"}` };
    }
  }
  return { ok: false, note: "This provider has no automated connection test." };
}

/** Applies a verified provider webhook event to the ledger, through the provider's own mapping. */
const webhookAppliers: Record<string, (supabase: ServiceClient, eventType: string, payload: Record<string, unknown>) => Promise<void>> = {
  square: applySquareWebhookEvent,
  stripe: applyStripeWebhookEvent,
};

export async function applyProviderWebhook(connection: PaymentConnection, supabase: ServiceClient, eventType: string, payload: Record<string, unknown>) {
  const apply = webhookAppliers[connection.provider];
  if (apply) await apply(supabase, eventType, payload);
}

/** The header each provider signs its webhooks in. */
const signatureHeaders: Record<string, string> = { square: "x-square-hmacsha256-signature", stripe: "stripe-signature" };
export function webhookSignature(connection: PaymentConnection, headers: Headers) {
  const name = signatureHeaders[connection.provider];
  return name ? headers.get(name) : null;
}
