import { z } from "zod";
import { checkoutInputSchema } from "@/lib/orders/schemas";
import { spokenDatabaseMessage } from "@/lib/errors/database";

/** The Web Payments SDK script the browser loads. Sandbox and production differ. */
export function squareWebSdkUrl(environment: string) {
  return environment === "production"
    ? "https://web.squarecdn.com/v1/square.js"
    : "https://sandbox.web.squarecdn.com/v1/square.js";
}

/** Non-secret configuration the storefront needs to start a card payment. */
export const checkoutPaymentConfigSchema = z.object({
  provider: z.string(),
  environment: z.string(),
  application_id: z.string(),
  location_id: z.string(),
  online_card_enabled: z.boolean(),
});
export type CheckoutPaymentConfig = z.infer<typeof checkoutPaymentConfigSchema>;

export const paymentProviderSettingsSchema = z.object({
  provider: z.enum(["none", "square"]),
  environment: z.enum(["sandbox", "production"]),
  application_id: z.string(),
  location_id: z.string(),
  notification_url: z.string(),
  online_card_enabled: z.boolean(),
  terminal_card_enabled: z.boolean(),
  updated_at: z.string(),
});
export type PaymentProviderSettings = z.infer<typeof paymentProviderSettingsSchema>;

export const paymentTerminalSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  device_id: z.string(),
  status: z.enum(["active", "disabled"]),
  notes: z.string(),
  last_used_at: z.string().nullable(),
  created_at: z.string(),
});
export type PaymentTerminal = z.infer<typeof paymentTerminalSchema>;

export const paymentConsoleSchema = z.object({
  settings: paymentProviderSettingsSchema,
  terminals: z.array(paymentTerminalSchema).default([]),
  counts: z.object({
    pending_payments: z.number().int(),
    failed_payments_24h: z.number().int(),
    pending_refunds: z.number().int(),
    unverified_webhooks: z.number().int(),
    unprocessed_webhooks: z.number().int(),
  }),
  recent_webhooks: z.array(z.object({
    event_id: z.string(), event_type: z.string(), signature_verified: z.boolean(),
    received_at: z.string(), processed_at: z.string().nullable(), processing_error: z.string().nullable(),
  })).default([]),
});
export type PaymentConsole = z.infer<typeof paymentConsoleSchema>;

export const paymentReconciliationSchema = z.object({
  totals: z.object({
    payment_count: z.number().int(), captured_count: z.number().int(), captured_cents: z.number().int(),
    failed_count: z.number().int(), pending_count: z.number().int(), refunded_cents: z.number().int(),
  }),
  exceptions: z.array(z.object({
    order_number: z.string(), issue: z.string(), detail: z.string(),
    amount_cents: z.number().int(), occurred_at: z.string().nullable(),
  })).default([]),
  webhook_failures: z.array(z.object({
    event_id: z.string(), event_type: z.string(), signature_verified: z.boolean(),
    received_at: z.string(), processing_error: z.string().nullable(),
  })).default([]),
});
export type PaymentReconciliation = z.infer<typeof paymentReconciliationSchema>;

/**
 * Browser -> server for an online card payment: the order to place and the
 * single-use card token. The browser never sees a card number and never sends one.
 */
export const cardCheckoutRequestSchema = z.object({
  order: checkoutInputSchema,
  payment: z.object({
    source_id: z.string().min(1).max(4000),
    verification_token: z.string().max(4000).nullable().optional(),
    idempotency_key: z.string().min(16).max(160),
  }),
});

export const cardCheckoutResultSchema = z.object({
  id: z.uuid(),
  public_access_token: z.uuid(),
  order_number: z.string(),
  total_cents: z.number().int(),
  payment_status: z.enum(["captured", "pending"]),
});

export const terminalActionSchema = z.object({
  order_id: z.uuid(),
  terminal_id: z.uuid(),
  idempotency_key: z.string().min(16).max(160),
  action: z.enum(["start", "status", "cancel"]),
});

export const refundRequestSchema = z.object({
  payment_id: z.uuid(),
  amount_cents: z.number().int().positive().max(10_000_000),
  reason: z.string().trim().min(3).max(1000),
  idempotency_key: z.string().min(16).max(160),
});

export const orderPaymentSchema = z.object({
  id: z.uuid(),
  provider: z.string(),
  provider_payment_id: z.string().nullable(),
  method: z.string(),
  status: z.enum(["pending", "authorized", "captured", "failed", "voided"]),
  provider_status: z.string().nullable(),
  amount_cents: z.number().int(),
  card_brand: z.string().nullable(),
  card_last4: z.string().nullable(),
  receipt_url: z.string().nullable(),
  failure_reason: z.string().nullable(),
  created_at: z.string(),
  refunded_cents: z.number().int().default(0),
});
export type OrderPayment = z.infer<typeof orderPaymentSchema>;

export const paymentStatusLabels: Record<string, string> = {
  pending: "Waiting on the card network",
  authorized: "Authorized, not captured",
  captured: "Paid",
  failed: "Failed",
  voided: "Voided",
};

/** Cents still refundable on a captured payment. */
export function refundableCents(payment: Pick<OrderPayment, "status" | "amount_cents" | "refunded_cents">) {
  if (payment.status !== "captured") return 0;
  return Math.max(0, payment.amount_cents - payment.refunded_cents);
}

/** Parses a refund amount a manager typed. Accepts "12", "12.50", "$12.50". */
export function parseAmountInput(raw: string) {
  const cleaned = (raw ?? "").replace(/[$,\s]/g, "");
  if (!cleaned) return { ok: false as const, error: "Enter the amount to refund." };
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { ok: false as const, error: "Enter an amount such as 12.50." };
  const cents = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return { ok: false as const, error: "Enter an amount greater than zero." };
  if (cents > 10_000_000) return { ok: false as const, error: "That amount is too large." };
  return { ok: true as const, cents };
}

/** Maps database errors from the payment RPCs to something staff can act on. */
export function paymentErrorMessage(error: { code?: string; message: string }) {
  if (error.code === "40001") return "A payment is already open on this order. Refresh and check it before retrying.";
  if (error.code === "42501") return "Your account is not allowed to make this change. Ask an owner.";
  return spokenDatabaseMessage(error, "The payment could not be updated. Check it before retrying.");
}
