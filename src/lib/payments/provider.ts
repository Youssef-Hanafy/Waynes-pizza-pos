export type PaymentState = "unpaid" | "authorized" | "paid" | "failed" | "refunded" | "partially_refunded";
export type PaymentResult = { provider: string; providerPaymentId: string | null; state: PaymentState; amountCents: number };

export interface PaymentProvider {
  readonly code: string;
  createOnlinePayment(input: { orderId: string; amountCents: number; idempotencyKey: string }): Promise<PaymentResult>;
  createCardPresentPayment(input: { orderId: string; amountCents: number; idempotencyKey: string }): Promise<PaymentResult>;
  capturePayment(providerPaymentId: string): Promise<PaymentResult>;
  voidPayment(providerPaymentId: string): Promise<PaymentResult>;
  refundPayment(input: { providerPaymentId: string; amountCents: number; idempotencyKey: string }): Promise<PaymentResult>;
  getPaymentStatus(providerPaymentId: string): Promise<PaymentResult>;
  handleWebhook(request: Request): Promise<void>;
}

export const TEST_MANUAL_PAYMENT = { provider: "manual", method: "test_manual", state: "unpaid" } as const;
