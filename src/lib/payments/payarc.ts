import { PaymentProviderError, type PaymentProvider, type ProviderPayment, type ProviderRefund } from "./provider";

export const payarcApiBase = (environment: string) => environment === "production" ? "https://api.payarc.net/v1" : "https://testapi.payarc.net/v1";
export type PayarcCharge = {
  id?: string; status?: string; amount?: number | string; amount_captured?: number | string;
  captured?: number | boolean; failure_code?: string | null; failure_message?: string | null;
  statement_description?: string;
  tip_amount?: number | string;
  card?: { data?: { id?: string; customer_id?: string | null; brand?: string; last4digit?: string } };
  refund?: { data?: PayarcRefund[] };
};
type PayarcRefund = { id?: string; charge_id?: string; status?: string; refund_amount?: number | string; description?: string };
const cents = (value: unknown) => (typeof value === "number" || typeof value === "string") && /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

/** Unknown processor states never become paid. Amounts come from the charge, never the browser. */
export function mapPayarcCharge(charge: PayarcCharge): ProviderPayment {
  const state = charge.status?.toLowerCase() ?? "unknown";
  const captured = charge.captured === 1 || charge.captured === true;
  const status = ["voided", "void"].includes(state) ? "voided"
    : ["declined", "failed", "failure"].includes(state) ? "failed"
    : ["submitted_for_settlement", "settled", "captured", "refunded", "partially_refunded"].includes(state) && captured ? "captured"
    : ["authorized", "authorised"].includes(state) && !captured ? "authorized" : "pending";
  return {
    providerPaymentId: charge.id ?? null, status, providerStatus: state,
    tipAmountCents: cents(charge.tip_amount),
    amountCents: status === "captured" ? cents(charge.amount_captured) ?? cents(charge.amount) : cents(charge.amount),
    cardBrand: charge.card?.data?.brand ?? null, cardLast4: charge.card?.data?.last4digit ?? null,
    metadata: { wayne_payarc_reference: charge.statement_description ?? "" },
    receiptUrl: null, failureReason: status === "failed" ? "The card was declined. Try another card." : null,
  };
}

function mapRefund(refund: PayarcRefund): ProviderRefund {
  return { providerRefundId: refund.id ?? null, providerStatus: refund.status ?? "unknown",
    status: refund.status === "refunded" ? "completed" : refund.status === "failed" ? "failed" : "pending", failureReason: null };
}

export function createPayarcProvider(config: { apiToken: string; environment: "sandbox" | "production" }): PaymentProvider {
  async function call<T>(path: string, method: "GET" | "POST" = "GET", body?: Record<string, unknown>, key?: string, responseOptional = false): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${payarcApiBase(config.environment)}${path}`, {
        method, headers: { Authorization: `Bearer ${config.apiToken}`, Accept: "application/json", "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new PaymentProviderError("Payarc did not answer. Check this payment before charging again.", "NETWORK", true); }
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      // Do not expose processor payloads: they may echo sensitive payment input.
      throw new PaymentProviderError(response.status === 422 ? "Payarc rejected the request. Review the transaction in Payarc before trying another payment." : "Payarc could not complete the request. Check the payment before trying again.", `PAYARC_HTTP_${response.status}`, true);
    }
    if (responseOptional) return data as T;
    if (!data || typeof data !== "object" || !("data" in data)) throw new PaymentProviderError("Payarc returned an incomplete response. Check the transaction before retrying.", "INVALID_RESPONSE", true);
    return (data as { data: T }).data;
  }
  const readCharge = (id: string) => call<PayarcCharge>(`/charges/${encodeURIComponent(id)}`);
  const unsupported = async (): Promise<never> => { throw new PaymentProviderError("This operation is not enabled for Payarc. Collect the tip before charging; card readers will be configured separately.", "UNSUPPORTED_OPERATION"); };
  return {
    code: "payarc",
    async createOnlinePayment({ amountCents, idempotencyKey, sourceId, referenceId }) {
      const charge = await call<PayarcCharge>("/charges", "POST", { amount: amountCents, currency: "usd", token_id: sourceId, capture: 1, statement_description: referenceId }, idempotencyKey);
      if (!charge.id) throw new PaymentProviderError("Payarc returned no charge ID. Check Payarc before paying again.", "INVALID_RESPONSE", true);
      return mapPayarcCharge(charge);
    },
    async createAdditionalPayment({ originalProviderPaymentId, amountCents, idempotencyKey, referenceId }) {
      const original = await readCharge(originalProviderPaymentId);
      const card = original.card?.data;
      if (original.id !== originalProviderPaymentId || mapPayarcCharge(original).status !== "captured" || !["submitted_for_settlement", "settled", "captured"].includes(original.status ?? "") || !card?.id) {
        throw new PaymentProviderError("The original card cannot be used for this extra charge. Collect the balance with another payment method.", "ORIGINAL_CARD_UNAVAILABLE");
      }
      const charge = await call<PayarcCharge>("/charges", "POST", {
        amount: amountCents, currency: "usd", card_id: card.id,
        ...(card.customer_id ? { customer_id: card.customer_id } : {}),
        capture: 1, statement_description: referenceId,
      }, idempotencyKey);
      if (!charge.id) throw new PaymentProviderError("Payarc returned no charge ID. Check this extra charge before paying again.", "INVALID_RESPONSE", true);
      return mapPayarcCharge(charge);
    },
    createOnlinePaymentIntent: unsupported, getOnlinePaymentIntent: unsupported,
    createCardPresentPayment: unsupported, getCardPresentPayment: unsupported, cancelCardPresentPayment: unsupported,
    // Delayed capture and post-payment tips stay disabled until merchant eligibility is confirmed.
    capturePayment: unsupported,
    async adjustTip(id, { tipCents, idempotencyKey }) {
      if (!Number.isSafeInteger(tipCents) || tipCents <= 0) throw new PaymentProviderError("The Payarc tip must be a positive amount in cents.", "INVALID_TIP");
      await call<unknown>(`/charges/${encodeURIComponent(id)}/tip_adjustment`, "POST", { tip: tipCents }, idempotencyKey, true);
      const charge = await readCharge(id);
      if (charge.id !== id) throw new PaymentProviderError("Payarc returned a different charge identity.", "PAYMENT_IDENTITY", true);
      return mapPayarcCharge(charge);
    },
    async voidPayment(id) {
      await call<PayarcCharge>(`/charges/${encodeURIComponent(id)}/void`, "POST", { reason: "requested_by_customer" });
      return mapPayarcCharge(await readCharge(id));
    },
    async refundPayment({ providerPaymentId, amountCents, idempotencyKey }) {
      const refund = await call<PayarcRefund>(`/charges/${encodeURIComponent(providerPaymentId)}/refunds`, "POST", {
        amount: amountCents, reason: "requested_by_customer", description: `wayne-refund:${idempotencyKey}`,
      }, idempotencyKey);
      if (!refund.id || refund.charge_id !== providerPaymentId || cents(refund.refund_amount) !== amountCents) throw new PaymentProviderError("The refund response needs review in Payarc. Do not submit another refund.", "REFUND_IDENTITY", true);
      return mapRefund(refund);
    },
    async findRefund({ providerPaymentId, amountCents, idempotencyKey }) {
      const charge = await readCharge(providerPaymentId);
      if (charge.id !== providerPaymentId || !Array.isArray(charge.refund?.data)) throw new PaymentProviderError("The refund history could not be verified.", "REFUND_HISTORY", true);
      const found = charge.refund.data.find((r) => r.description === `wayne-refund:${idempotencyKey}`);
      if (!found) return null;
      if (found.charge_id !== providerPaymentId || cents(found.refund_amount) !== amountCents) throw new PaymentProviderError("The refund identity needs review.", "REFUND_IDENTITY", true);
      return mapRefund(found);
    },
    async getPaymentStatus(id) {
      const charge = await readCharge(id);
      if (charge.id !== id) throw new PaymentProviderError("Payarc returned a different charge identity.", "PAYMENT_IDENTITY", true);
      return mapPayarcCharge(charge);
    },
    // Payarc's public docs do not specify a signing scheme. Its dedicated receiver
    // uses a secret URL and an authoritative API read, never fabricated verification.
    handleWebhook() { return { eventId: "", eventType: "", signatureVerified: false, payload: {} }; },
  };
}
