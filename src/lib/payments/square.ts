import "server-only";

import { PaymentProviderError, type PaymentProvider, type WebhookEnvelope } from "./provider";
import {
  describeSquareError, mapSquarePayment, RETRYABLE_CODES,
  squareCheckoutStatus, squareRefundStatus, verifySquareSignature,
  type SquareError, type SquarePayment,
} from "./square-mapping";

/**
 * Square adapter. Plain fetch against the documented REST API rather than the SDK:
 * one less dependency to keep current, and every request and mapping is visible here.
 *
 * Pinned API version — Square holds a response shape stable for a given version, so
 * this only moves when someone deliberately upgrades and re-tests.
 */
export const SQUARE_API_VERSION = "2026-08-19";

export type SquareConfig = {
  accessToken: string;
  environment: "sandbox" | "production";
  applicationId: string;
  locationId: string;
  notificationUrl: string;
  webhookSignatureKey: string;
};

export function squareApiBase(environment: "sandbox" | "production") {
  return environment === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
}

export function createSquareProvider(config: SquareConfig): PaymentProvider {
  const base = squareApiBase(config.environment);

  async function call<T>(path: string, init: { method: "GET" | "POST"; body?: unknown }, fallback: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: init.method,
        headers: {
          "Square-Version": SQUARE_API_VERSION,
          Authorization: `Bearer ${config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      // A network failure is never a payment: the caller leaves the ledger pending
      // and reconciliation or the webhook decides the truth.
      throw new PaymentProviderError("The payment network did not answer. Do not retry the charge until the payment is checked.", "NETWORK", true);
    }
    const text = await response.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok) {
      const errors = (body as { errors?: SquareError[] } | null)?.errors;
      const { message, code } = describeSquareError(errors, fallback);
      throw new PaymentProviderError(message, code, RETRYABLE_CODES.has(code) || response.status >= 500);
    }
    return body as T;
  }

  return {
    code: "square",

    async createOnlinePayment({ amountCents, idempotencyKey, sourceId, referenceId, note, verificationToken }) {
      const body = await call<{ payment?: SquarePayment }>("/v2/payments", {
        method: "POST",
        body: {
          idempotency_key: idempotencyKey.slice(0, 45),
          source_id: sourceId,
          amount_money: { amount: amountCents, currency: "USD" },
          location_id: config.locationId,
          autocomplete: true,
          reference_id: referenceId.slice(0, 40),
          note: note.slice(0, 500),
          ...(verificationToken ? { verification_token: verificationToken } : {}),
        },
      }, "The card could not be charged. No money was taken.");
      return mapSquarePayment(body.payment);
    },

    async createCardPresentPayment({ amountCents, idempotencyKey, deviceId, referenceId, note }) {
      const body = await call<{ checkout?: { id?: string; status?: string; amount_money?: { amount?: number }; payment_ids?: string[] } }>(
        "/v2/terminals/checkouts",
        {
          method: "POST",
          body: {
            idempotency_key: idempotencyKey.slice(0, 45),
            checkout: {
              amount_money: { amount: amountCents, currency: "USD" },
              device_options: { device_id: deviceId, skip_receipt_screen: false },
              reference_id: referenceId.slice(0, 40),
              note: note.slice(0, 500),
              payment_type: "CARD_PRESENT",
              deadline_duration: "PT5M",
            },
          },
        },
        "The card reader could not be reached.",
      );
      return {
        checkoutId: body.checkout?.id ?? "",
        providerPaymentId: body.checkout?.payment_ids?.[0] ?? null,
        status: squareCheckoutStatus(body.checkout?.status),
        providerStatus: body.checkout?.status ?? "",
        amountCents: body.checkout?.amount_money?.amount ?? amountCents,
        cardBrand: null, cardLast4: null, receiptUrl: null, failureReason: null,
      };
    },

    async getCardPresentPayment(checkoutId) {
      const body = await call<{ checkout?: { id?: string; status?: string; amount_money?: { amount?: number }; payment_ids?: string[]; cancel_reason?: string } }>(
        `/v2/terminals/checkouts/${encodeURIComponent(checkoutId)}`, { method: "GET" }, "The card reader status could not be read.");
      return {
        checkoutId: body.checkout?.id ?? checkoutId,
        providerPaymentId: body.checkout?.payment_ids?.[0] ?? null,
        status: squareCheckoutStatus(body.checkout?.status),
        providerStatus: body.checkout?.status ?? "",
        amountCents: body.checkout?.amount_money?.amount ?? null,
        cardBrand: null, cardLast4: null, receiptUrl: null,
        failureReason: body.checkout?.cancel_reason ?? null,
      };
    },

    async cancelCardPresentPayment(checkoutId) {
      const body = await call<{ checkout?: { id?: string; status?: string; cancel_reason?: string } }>(
        `/v2/terminals/checkouts/${encodeURIComponent(checkoutId)}/cancel`, { method: "POST" }, "The card reader request could not be cancelled.");
      return {
        checkoutId: body.checkout?.id ?? checkoutId,
        providerPaymentId: null,
        status: squareCheckoutStatus(body.checkout?.status),
        providerStatus: body.checkout?.status ?? "",
        amountCents: null, cardBrand: null, cardLast4: null, receiptUrl: null,
        failureReason: body.checkout?.cancel_reason ?? null,
      };
    },

    async capturePayment(providerPaymentId) {
      const body = await call<{ payment?: SquarePayment }>(`/v2/payments/${encodeURIComponent(providerPaymentId)}/complete`, { method: "POST" }, "The payment could not be completed.");
      return mapSquarePayment(body.payment);
    },

    async voidPayment(providerPaymentId) {
      const body = await call<{ payment?: SquarePayment }>(`/v2/payments/${encodeURIComponent(providerPaymentId)}/cancel`, { method: "POST" }, "The payment could not be voided.");
      return mapSquarePayment(body.payment);
    },

    async refundPayment({ providerPaymentId, amountCents, idempotencyKey, reason }) {
      const body = await call<{ refund?: { id?: string; status?: string } }>("/v2/refunds", {
        method: "POST",
        body: {
          idempotency_key: idempotencyKey.slice(0, 45),
          payment_id: providerPaymentId,
          amount_money: { amount: amountCents, currency: "USD" },
          reason: reason.slice(0, 192),
        },
      }, "The refund could not be sent to the card network.");
      return {
        providerRefundId: body.refund?.id ?? null,
        status: squareRefundStatus(body.refund?.status),
        providerStatus: body.refund?.status ?? "",
        failureReason: null,
      };
    },

    async getPaymentStatus(providerPaymentId) {
      const body = await call<{ payment?: SquarePayment }>(`/v2/payments/${encodeURIComponent(providerPaymentId)}`, { method: "GET" }, "The payment status could not be read.");
      return mapSquarePayment(body.payment);
    },

    handleWebhook({ rawBody, signature }) {
      const verified = verifySquareSignature({
        rawBody, signature,
        notificationUrl: config.notificationUrl,
        signatureKey: config.webhookSignatureKey,
      });
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(rawBody) as Record<string, unknown>; } catch { parsed = {}; }
      return {
        eventId: typeof parsed.event_id === "string" ? parsed.event_id : "",
        eventType: typeof parsed.type === "string" ? parsed.type : "",
        signatureVerified: verified,
        payload: parsed,
      } satisfies WebhookEnvelope;
    },
  };
}

export { readSquareWebhookObject, squareCheckoutStatus, squarePaymentStatus, squareRefundStatus, verifySquareSignature } from "./square-mapping";
