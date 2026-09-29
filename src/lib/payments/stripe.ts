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
  id?: string; status?: string; amount?: number; client_secret?: string;
  last_payment_error?: { code?: string; message?: string };
  payment_method?: { card?: StripeCard } | string | null;
  charges?: { data?: Array<{ receipt_url?: string; payment_method_details?: { card?: StripeCard } }> };
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
  const card = typeof intent.payment_method === "object" ? intent.payment_method?.card : intent.charges?.data?.[0]?.payment_method_details?.card;
  return {
    providerPaymentId: intent.id ?? null,
    status: stripeStatus(intent.status),
    providerStatus: intent.status ?? "",
    amountCents: typeof intent.amount === "number" ? intent.amount : null,
    cardBrand: card?.brand ?? null,
    cardLast4: card?.last4 ?? null,
    receiptUrl: intent.charges?.data?.[0]?.receipt_url ?? null,
    failureReason: intent.last_payment_error ? "The card was declined. Try another card." : null,
  };
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
    const intent = await call<StripePaymentIntent>(`/v1/payment_intents/${encodeURIComponent(providerPaymentId)}`, { method: "GET" }, "The payment status could not be read.");
    const mapped = mapIntent(intent);
    if (!intent.client_secret || !mapped.providerPaymentId) throw new PaymentProviderError("Stripe returned an incomplete payment intent.", "INVALID_RESPONSE");
    return { ...mapped, clientSecret: intent.client_secret };
  }

  return {
    code: "stripe",

    async createOnlinePayment() {
      throw new PaymentProviderError("This Stripe checkout must be confirmed in the secure card form.", "UNSUPPORTED_OPERATION");
    },

    async createOnlinePaymentIntent({ amountCents, idempotencyKey, referenceId, note, paymentId, receiptEmail }) {
      const intent = await call<StripePaymentIntent>("/v1/payment_intents", {
        method: "POST",
        idempotencyKey,
        body: form({
          amount: amountCents,
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

    async capturePayment(providerPaymentId) {
      const intent = await call<StripePaymentIntent>(`/v1/payment_intents/${encodeURIComponent(providerPaymentId)}/capture`, { method: "POST" }, "The payment could not be captured.");
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
      return mapIntent(await call<StripePaymentIntent>(`/v1/payment_intents/${encodeURIComponent(providerPaymentId)}`, { method: "GET" }, "The payment status could not be read."));
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
