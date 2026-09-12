import { createHmac, timingSafeEqual } from "node:crypto";
import type { LedgerStatus, RefundLedgerStatus } from "./provider";

/**
 * Pure Square mapping and verification. Kept apart from the HTTP adapter so the
 * rules that decide "is this money real" can be tested directly.
 */

export type SquareError = { category?: string; code?: string; detail?: string };

export type SquarePayment = {
  id?: string; status?: string; amount_money?: { amount?: number };
  card_details?: { card?: { card_brand?: string; last_4?: string }; errors?: SquareError[] };
  receipt_url?: string;
};

/** Square's own decline codes are safe to show; anything else is not. */
export const CUSTOMER_SAFE_CODES = new Set([
  "CARD_DECLINED", "CARD_DECLINED_CALL_ISSUER", "CARD_DECLINED_VERIFICATION_REQUIRED", "CVV_FAILURE",
  "ADDRESS_VERIFICATION_FAILURE", "INVALID_EXPIRATION", "EXPIRATION_FAILURE", "INSUFFICIENT_FUNDS",
  "INVALID_ACCOUNT", "GENERIC_DECLINE", "PAYMENT_LIMIT_EXCEEDED", "TEMPORARY_ERROR", "TRANSACTION_LIMIT",
  "CARD_EXPIRED", "INVALID_CARD", "INVALID_CARD_DATA", "INVALID_POSTAL_CODE", "VOICE_FAILURE",
]);

const FRIENDLY: Record<string, string> = {
  CARD_DECLINED: "The card was declined. Try another card.",
  CARD_DECLINED_CALL_ISSUER: "The card was declined — the customer should call their bank.",
  CVV_FAILURE: "The security code did not match. Check it and try again.",
  ADDRESS_VERIFICATION_FAILURE: "The billing postal code did not match. Check it and try again.",
  INSUFFICIENT_FUNDS: "The card was declined for insufficient funds.",
  EXPIRATION_FAILURE: "The expiry date is not valid.",
  INVALID_EXPIRATION: "The expiry date is not valid.",
  CARD_EXPIRED: "That card has expired.",
  PAYMENT_LIMIT_EXCEEDED: "The card was declined — over its limit.",
  TEMPORARY_ERROR: "The card network is busy. Try again in a moment.",
};

export const RETRYABLE_CODES = new Set(["TEMPORARY_ERROR", "RATE_LIMITED", "SERVICE_UNAVAILABLE", "GATEWAY_TIMEOUT"]);

export function describeSquareError(errors: SquareError[] | undefined, fallback: string) {
  const first = errors?.[0];
  const code = first?.code ?? "";
  if (FRIENDLY[code]) return { message: FRIENDLY[code], code };
  if (CUSTOMER_SAFE_CODES.has(code)) return { message: "The card was declined. Try another card.", code };
  return { message: fallback, code: code || "PROVIDER_ERROR" };
}

/** Anything Square has not explicitly completed is treated as not-yet-money. */
export function squarePaymentStatus(status: string | undefined): LedgerStatus {
  switch (status) {
    case "COMPLETED": return "captured";
    case "APPROVED": return "authorized";
    case "PENDING": return "pending";
    case "CANCELED": return "voided";
    case "FAILED": return "failed";
    default: return "pending";
  }
}

export function squareCheckoutStatus(status: string | undefined): LedgerStatus {
  switch (status) {
    case "COMPLETED": return "captured";
    case "PENDING":
    case "IN_PROGRESS":
    case "CANCEL_REQUESTED": return "pending";
    case "CANCELED": return "voided";
    default: return "failed";
  }
}

export function squareRefundStatus(status: string | undefined): RefundLedgerStatus {
  switch (status) {
    case "COMPLETED": return "completed";
    case "PENDING": return "pending";
    case "REJECTED": return "rejected";
    case "FAILED": return "failed";
    default: return "pending";
  }
}

export function mapSquarePayment(payment: SquarePayment | undefined) {
  const declined = payment?.card_details?.errors?.[0];
  return {
    providerPaymentId: payment?.id ?? null,
    status: squarePaymentStatus(payment?.status),
    providerStatus: payment?.status ?? "",
    amountCents: typeof payment?.amount_money?.amount === "number" ? payment.amount_money.amount : null,
    cardBrand: payment?.card_details?.card?.card_brand ?? null,
    cardLast4: payment?.card_details?.card?.last_4 ?? null,
    receiptUrl: payment?.receipt_url ?? null,
    failureReason: declined ? `${declined.code ?? "DECLINED"}${declined.detail ? `: ${declined.detail}` : ""}`.slice(0, 500) : null,
  };
}

/**
 * Square signs the notification URL concatenated with the raw body, HMAC-SHA-256,
 * base64. The URL must be the exact string registered on the subscription, which is
 * why it is stored configuration rather than rebuilt from the incoming request.
 */
export function verifySquareSignature({ rawBody, signature, notificationUrl, signatureKey }: {
  rawBody: string; signature: string | null; notificationUrl: string; signatureKey: string;
}) {
  if (!signature || !signatureKey || !notificationUrl) return false;
  const expected = createHmac("sha256", signatureKey).update(notificationUrl + rawBody, "utf8").digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Pulls the payment, refund or checkout out of a Square webhook envelope. */
export function readSquareWebhookObject(payload: Record<string, unknown>) {
  const data = payload.data as { type?: string; id?: string; object?: Record<string, unknown> } | undefined;
  const object = data?.object ?? {};
  return {
    objectType: data?.type ?? "",
    payment: object.payment as SquarePayment | undefined,
    refund: object.refund as { id?: string; status?: string; payment_id?: string } | undefined,
    checkout: object.checkout as { id?: string; status?: string; payment_ids?: string[] } | undefined,
  };
}
