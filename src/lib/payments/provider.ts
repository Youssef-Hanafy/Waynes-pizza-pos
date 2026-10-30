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
  /** Current provider metadata, read with the payment rather than from an old event. */
  metadata?: Record<string, string>;
  /**
   * An authorised (not yet captured) card that may be captured for MORE than
   * was authorised — Stripe "overcapture", used to add a delivery tip after the
   * driver returns (owner, 2026-10-11).  Null when the card can't be increased.
   */
  maxCapturableCents?: number | null;
  /** The saved card (Stripe) behind a tip-adjust approval, used to charge order + tip once. */
  paymentMethodId?: string | null;
  customerId?: string | null;
};

export type ProviderTerminalCheckout = ProviderPayment & { checkoutId: string };

/** A server-created intent whose client secret is safe to give Stripe.js. */
export type ProviderOnlinePaymentIntent = ProviderPayment & { clientSecret: string };

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
  /** Create an online PaymentIntent before Stripe.js collects the card details. */
  createOnlinePaymentIntent(input: { amountCents: number; idempotencyKey: string; referenceId: string; note: string; paymentId: string; receiptEmail?: string | null;
    /** Only HOLD this much on the card (manual capture); charged later with capturePayment. */
    holdCents?: number | null;
    /**
     * Authorise the amount now and capture later (with a tip added) — the
     * restaurant "tip adjust" flow for delivery cards keyed in over the phone.
     */
    tipAdjust?: boolean }): Promise<ProviderOnlinePaymentIntent>;
  getOnlinePaymentIntent(providerPaymentId: string): Promise<ProviderOnlinePaymentIntent>;
  /** Ask a paired card reader to collect a card-present payment. */
  createCardPresentPayment(input: { amountCents: number; idempotencyKey: string; deviceId: string; referenceId: string; note: string }): Promise<ProviderTerminalCheckout>;
  getCardPresentPayment(checkoutId: string): Promise<ProviderTerminalCheckout>;
  cancelCardPresentPayment(checkoutId: string): Promise<ProviderTerminalCheckout>;
  /** Charge a held card. amountCents (≤ the hold) charges less than the hold and releases the rest. */
  capturePayment(providerPaymentId: string, options?: { amountCents?: number; idempotencyKey?: string }): Promise<ProviderPayment>;
  voidPayment(providerPaymentId: string): Promise<ProviderPayment>;
  /** Prepare without charging. Persist its ID before confirming it. Stripe only. */
  createSavedCardIntent?(input: { customerId: string; paymentMethodId: string; amountCents: number; idempotencyKey: string; note: string; metadata?: Record<string, string> }): Promise<ProviderPayment>;
  confirmSavedCardIntent?(providerPaymentId: string, idempotencyKey: string): Promise<ProviderPayment>;
  /** Cancel an approval that a fresh charge replaced, marked so its webhook is ignored. */
  releaseHold?(providerPaymentId: string, replacedBy: string): Promise<ProviderPayment>;
  refundPayment(input: { providerPaymentId: string; amountCents: number; idempotencyKey: string; reason: string }): Promise<ProviderRefund>;
  /** Authoritative lookup by durable refund-leg metadata, including after a lost response. */
  findRefund?(input: { providerPaymentId: string; amountCents: number; idempotencyKey: string }): Promise<ProviderRefund | null>;
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
