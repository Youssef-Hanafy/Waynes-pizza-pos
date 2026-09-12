export type PaymentState = "unpaid" | "authorized" | "paid" | "failed" | "refunded" | "partially_refunded";
export type PaymentResult = { provider: string; providerPaymentId: string | null; state: PaymentState; amountCents: number };

/** How the payment ledger records a provider answer. */
export type LedgerStatus = "pending" | "authorized" | "captured" | "failed" | "voided";
export type RefundLedgerStatus = "pending" | "completed" | "rejected" | "failed";

export type ProviderPayment = {
  providerPaymentId: string | null;
  status: LedgerStatus;
  providerStatus: string;
  amountCents: number | null;
  cardBrand: string | null;
  cardLast4: string | null;
  receiptUrl: string | null;
  failureReason: string | null;
};

export type ProviderTerminalCheckout = ProviderPayment & { checkoutId: string };

export type ProviderRefund = {
  providerRefundId: string | null;
  status: RefundLedgerStatus;
  providerStatus: string;
  failureReason: string | null;
};

export type WebhookEnvelope = {
  eventId: string;
  eventType: string;
  signatureVerified: boolean;
  payload: Record<string, unknown>;
};

/**
 * The rest of the system depends on this interface, never on a processor SDK
 * (master build sheet §20). A provider implementation is only ever reached through
 * a configured, switched-on provider; with none configured the app never calls one.
 */
export interface PaymentProvider {
  readonly code: string;
  /** Charge a card tokenized in the browser. */
  createOnlinePayment(input: { amountCents: number; idempotencyKey: string; sourceId: string; referenceId: string; note: string; verificationToken?: string | null }): Promise<ProviderPayment>;
  /** Ask a paired card reader to collect a card-present payment. */
  createCardPresentPayment(input: { amountCents: number; idempotencyKey: string; deviceId: string; referenceId: string; note: string }): Promise<ProviderTerminalCheckout>;
  getCardPresentPayment(checkoutId: string): Promise<ProviderTerminalCheckout>;
  cancelCardPresentPayment(checkoutId: string): Promise<ProviderTerminalCheckout>;
  capturePayment(providerPaymentId: string): Promise<ProviderPayment>;
  voidPayment(providerPaymentId: string): Promise<ProviderPayment>;
  refundPayment(input: { providerPaymentId: string; amountCents: number; idempotencyKey: string; reason: string }): Promise<ProviderRefund>;
  getPaymentStatus(providerPaymentId: string): Promise<ProviderPayment>;
  /** Verifies the signature and normalises the envelope. Never trusts an unsigned body. */
  handleWebhook(input: { rawBody: string; signature: string | null }): WebhookEnvelope;
}

export const TEST_MANUAL_PAYMENT = { provider: "manual", method: "test_manual", state: "unpaid" } as const;

/** Raised for a provider answer the customer or staff member can act on. */
export class PaymentProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(message: string, code = "PROVIDER_ERROR", retryable = false) {
    super(message);
    this.name = "PaymentProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}
