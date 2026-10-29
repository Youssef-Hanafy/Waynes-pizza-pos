import "server-only";

import {
  PaymentProviderError,
  type PaymentProvider,
  type ProviderOnlinePaymentIntent,
  type ProviderPayment,
  type ProviderRefund,
  type ProviderTerminalCheckout,
  type WebhookEnvelope,
} from "./provider";
import { verifyStripeSignature } from "./stripe-mapping";

export type StripeConfig = { secretKey: string; webhookSecret: string };

type StripeCard = { brand?: string; last4?: string };
type StripePaymentIntent = {
  id?: string; status?: string; amount?: number; amount_received?: number; client_secret?: string;
  last_payment_error?: { code?: string; message?: string };
  payment_method?: { id?: string; card?: StripeCard } | string | null;
  customer?: string | { id?: string } | null;
  metadata?: Record<string, string>;
  charges?: { data?: Array<{ receipt_url?: string; payment_method_details?: { card?: StripeCard } }> };
  amount_capturable?: number;
  latest_charge?: string | {
    receipt_url?: string;
    payment_method_details?: {
      card?: StripeCard & { overcapture?: { maximum_amount_capturable?: number; status?: string } };
      /** A card tapped / inserted on the M2. */
      card_present?: StripeCard & { overcapture_supported?: boolean };
    };
  } | null;
};
type StripeRefund = { id?: string; status?: string; failure_reason?: string | null };
type StripeErrorBody = { error?: { type?: string; code?: string; message?: string } };

function stripeStatus(status: string | undefined): ProviderPayment["status"] {
  switch (status) {
    case "succeeded": return "captured";
    case "requires_capture": return "authorized";
    case "canceled": return "voided";
    case "requires_payment_method": return "failed";
    default: return "pending";
  }
}

function mapIntent(intent: StripePaymentIntent): ProviderPayment {
  const charge = intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  const card = typeof intent.payment_method === "object" && intent.payment_method?.card ? intent.payment_method.card
    : charge?.payment_method_details?.card ?? charge?.payment_method_details?.card_present ?? intent.charges?.data?.[0]?.payment_method_details?.card;
  const maxCapturableCents = intent.status === "requires_capture" ? overcaptureLimitCents(intent) : null;
  return {
    providerPaymentId: intent.id ?? null,
    status: stripeStatus(intent.status),
    providerStatus: intent.status ?? "",
    amountCents: intent.status === "succeeded" && typeof intent.amount_received === "number"
      ? intent.amount_received : typeof intent.amount === "number" ? intent.amount : null,
    cardBrand: card?.brand ?? null,
    cardLast4: card?.last4 ?? null,
    receiptUrl: charge?.receipt_url ?? intent.charges?.data?.[0]?.receipt_url ?? null,
    failureReason: intent.last_payment_error ? "The card was declined. Try another card." : null,
    maxCapturableCents,
    paymentMethodId: typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id ?? null,
    customerId: typeof intent.customer === "string" ? intent.customer : intent.customer?.id ?? null,
  };
}

/**
 * How far a held card can be captured — order + the most tip it can take
 * (Stripe overcapture, owner 2026-10-13).  Online / keyed cards: Stripe gives
 * the exact maximum.  Cards tapped on the M2: when overcapture is supported the
 * limit is the authorised amount plus 50% or $50, whichever is greater.
 * Otherwise only the authorised amount (no tip can be added).
 */
export function overcaptureLimitCents(intent: Pick<StripePaymentIntent, "amount" | "amount_capturable" | "latest_charge">): number | null {
  const charge = intent.latest_charge && typeof intent.latest_charge === "object" ? intent.latest_charge : null;
  const authorized = typeof intent.amount_capturable === "number" && intent.amount_capturable > 0 ? intent.amount_capturable : intent.amount ?? null;
  const online = charge?.payment_method_details?.card?.overcapture;
  if (online?.status === "available" && typeof online.maximum_amount_capturable === "number") return online.maximum_amount_capturable;
  const present = charge?.payment_method_details?.card_present;
  if (present?.overcapture_supported && typeof authorized === "number") return authorized + Math.max(Math.round(authorized / 2), 5000);
  return authorized;
}

function form(data: Record<string, string | number | boolean | null | undefined>) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) if (value !== null && value !== undefined) body.set(key, String(value));
  return body;
}

function stripeError(body: StripeErrorBody | null, fallback: string, status: number) {
  const code = body?.error?.code ?? body?.error?.type ?? "STRIPE_ERROR";
  const customerErrors = new Set(["card_declined", "expired_card", "incorrect_cvc", "incorrect_number", "insufficient_funds", "invalid_expiry_month", "invalid_expiry_year", "processing_error"]);
  return new PaymentProviderError(
    customerErrors.has(code) ? "The card was declined. Try another card." : fallback,
    code,
    status === 429 || status >= 500,
  );
}

/** Stripe adapter for website payments. Terminal methods are deliberately disabled until that project starts. */
export function createStripeProvider(config: StripeConfig): PaymentProvider {
  async function call<T>(path: string, init: { method: "GET" | "POST"; body?: URLSearchParams; idempotencyKey?: string }, fallback: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`https://api.stripe.com${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${config.secretKey}`,
          ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
        },
        body: init.body,
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new PaymentProviderError("The payment network did not answer. Do not retry the charge until the payment is checked.", "NETWORK", true);
    }
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) throw stripeError(body as StripeErrorBody | null, fallback, response.status);
    return body as T;
  }

  async function readIntent(providerPaymentId: string): Promise<ProviderOnlinePaymentIntent> {
    const intent = await call<StripePaymentIntent>(`/v1/payment_intents/${encodeURIComponent(providerPaymentId)}?expand[]=latest_charge`, { method: "GET" }, "The payment status could not be read.");
    const mapped = mapIntent(intent);
    if (!intent.client_secret || !mapped.providerPaymentId) throw new PaymentProviderError("Stripe returned an incomplete payment intent.", "INVALID_RESPONSE");
    return { ...mapped, clientSecret: intent.client_secret };
  }

  return {
    code: "stripe",

    async createOnlinePayment() {
      throw new PaymentProviderError("This Stripe checkout must be confirmed in the secure card form.", "UNSUPPORTED_OPERATION");
    },

    async createOnlinePaymentIntent({ amountCents, idempotencyKey, referenceId, note, paymentId, receiptEmail, holdCents, tipAdjust }) {
      const hold = holdCents && holdCents > 0 ? Math.round(holdCents) : null;
      const manual = Boolean(hold) || Boolean(tipAdjust);
      // Tip adjust without Stripe "overcapture" (2026-10-19: the account is not
      // eligible — Stripe answered "This account is not eligible for the requested
      // card features").  The card is approved for the order and SAVED to a Stripe
      // customer; at cash-out a card with a tip is charged once for order + tip from
      // the saved card and the first approval is cancelled (no fee on a cancelled
      // approval), so it is still one charge, one fee.
      let customerId: string | null = null;
      if (tipAdjust) {
        const customer = await call<{ id?: string }>("/v1/customers", {
          method: "POST", idempotencyKey: `${idempotencyKey}-customer`,
          body: form({ description: `Order ${referenceId}`.slice(0, 350), "metadata[wayne_payment_id]": paymentId, "metadata[wayne_order_number]": referenceId }),
        }, "The payment could not be prepared. Please try again.");
        customerId = customer.id ?? null;
      }
      const intent = await call<StripePaymentIntent>("/v1/payment_intents", {
        method: "POST",
        idempotencyKey,
        body: form({
          amount: hold ?? amountCents,
          // A delivery card (owner, 2026-10-11): authorised for the order now, captured at the
          // driver's cash-out for the order PLUS the tip on the slip — one charge, one fee.
          // Stripe "overcapture" lets the capture be larger than the authorisation.
          capture_method: manual ? "manual" : undefined,
          customer: customerId ?? undefined,
          setup_future_usage: customerId ? "off_session" : undefined,
          "metadata[wayne_tip_adjust]": tipAdjust ? "true" : undefined,
          "metadata[wayne_hold_cents]": hold ?? undefined,
          currency: "usd",
          "payment_method_types[]": "card",
          description: note.slice(0, 500),
          receipt_email: receiptEmail || undefined,
          "metadata[wayne_payment_id]": paymentId,
          "metadata[wayne_order_number]": referenceId,
        }),
      }, "The payment could not be prepared. Please try again.");
      const mapped = mapIntent(intent);
      if (!intent.client_secret || !mapped.providerPaymentId) throw new PaymentProviderError("Stripe returned an incomplete payment intent.", "INVALID_RESPONSE");
      return { ...mapped, clientSecret: intent.client_secret };
    },

    getOnlinePaymentIntent: readIntent,

    async createCardPresentPayment(): Promise<ProviderTerminalCheckout> {
      throw new PaymentProviderError("Stripe Terminal is not configured yet.", "TERMINAL_DISABLED");
    },
    async getCardPresentPayment(): Promise<ProviderTerminalCheckout> {
      throw new PaymentProviderError("Stripe Terminal is not configured yet.", "TERMINAL_DISABLED");
    },
    async cancelCardPresentPayment(): Promise<ProviderTerminalCheckout> {
      throw new PaymentProviderError("Stripe Terminal is not configured yet.", "TERMINAL_DISABLED");
    },

    async capturePayment(providerPaymentId, options) {
      const intent = await call<StripePaymentIntent>(`/v1/payment_intents/${encodeURIComponent(providerPaymentId)}/capture`, {
        method: "POST",
        idempotencyKey: options?.idempotencyKey,
        body: form({ amount_to_capture: options?.amountCents ? Math.round(options.amountCents) : undefined, "expand[]": "latest_charge" }),
      }, "The card could not be charged.");
      return mapIntent(intent);
    },
    async createSavedCardIntent({ customerId, paymentMethodId, amountCents, idempotencyKey, note, metadata }) {
      const extra: Record<string, string> = {};
      for (const [key, value] of Object.entries(metadata ?? {})) extra[`metadata[${key}]`] = value;
      const intent = await call<StripePaymentIntent>("/v1/payment_intents", {
        method: "POST", idempotencyKey,
        body: form({
          amount: Math.round(amountCents), currency: "usd", customer: customerId, payment_method: paymentMethodId,
          confirm: false, "payment_method_types[]": "card", description: note.slice(0, 500), "expand[]": "latest_charge", ...extra,
        }),
      }, "The card could not be charged for the tip.");
      return mapIntent(intent);
    },
    async confirmSavedCardIntent(providerPaymentId, idempotencyKey) {
      const intent = await call<StripePaymentIntent>(`/v1/payment_intents/${encodeURIComponent(providerPaymentId)}/confirm`, {
        method: "POST", idempotencyKey, body: form({ off_session: true, "expand[]": "latest_charge" }),
      }, "The saved card could not be confirmed. Its outcome must be checked before another payment.");
      return mapIntent(intent);
    },
    async releaseHold(providerPaymentId, replacedBy) {
      await call<StripePaymentIntent>(`/v1/payment_intents/${encodeURIComponent(providerPaymentId)}`, {
        method: "POST", body: form({ "metadata[wayne_replaced_by]": replacedBy }),
      }, "The first approval could not be marked.");
      const intent = await call<StripePaymentIntent>(`/v1/payment_intents/${encodeURIComponent(providerPaymentId)}/cancel`, { method: "POST", body: form({ cancellation_reason: "duplicate" }) }, "The first approval could not be released.");
      return mapIntent(intent);
    },
    async voidPayment(providerPaymentId) {
      const intent = await call<StripePaymentIntent>(`/v1/payment_intents/${encodeURIComponent(providerPaymentId)}/cancel`, { method: "POST" }, "The payment could not be cancelled.");
      return mapIntent(intent);
    },
    async refundPayment({ providerPaymentId, amountCents, idempotencyKey, reason }): Promise<ProviderRefund> {
      const refund = await call<StripeRefund>("/v1/refunds", {
        method: "POST", idempotencyKey,
        body: form({ payment_intent: providerPaymentId, amount: amountCents, reason: "requested_by_customer", "metadata[wayne_reason]": reason.slice(0, 500) }),
      }, "The refund could not be sent to the card network.");
      return {
        providerRefundId: refund.id ?? null,
        status: refund.status === "succeeded" ? "completed" : refund.status === "pending" ? "pending" : "failed",
        providerStatus: refund.status ?? "",
        failureReason: refund.failure_reason ?? null,
      };
    },
    async getPaymentStatus(providerPaymentId) {
      return mapIntent(await call<StripePaymentIntent>(`/v1/payment_intents/${encodeURIComponent(providerPaymentId)}?expand[]=latest_charge`, { method: "GET" }, "The payment status could not be read."));
    },
    handleWebhook({ rawBody, signature }): WebhookEnvelope {
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(rawBody) as Record<string, unknown>; } catch { /* verification remains false */ }
      return {
        eventId: typeof parsed.id === "string" ? parsed.id : "",
        eventType: typeof parsed.type === "string" ? parsed.type : "",
        signatureVerified: verifyStripeSignature(rawBody, signature, config.webhookSecret),
        payload: parsed,
      };
    },
  };
}

export { readStripeWebhookObject, verifyStripeSignature } from "./stripe-mapping";
