import { status, type HardwareStatus, type PaymentRequest, type PaymentResult } from "../types";

/**
 * The card terminal at the counter (§25).  Order logic never names a
 * processor; it asks this interface.  Online card payments stay on the server
 * `PaymentProvider` (src/lib/payments/provider.ts).
 */
export interface PaymentTerminalProvider {
  getStatus(): Promise<HardwareStatus>;
  beginPayment(request: PaymentRequest): Promise<PaymentResult>;
  cancelPayment(orderId: string): Promise<void>;
  getPaymentStatus(orderId: string): Promise<PaymentResult | null>;
  refund(request: PaymentRequest & { reason: string }): Promise<PaymentResult>;
}

function dollars(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * Wayne's current reality: the processor's own terminal, not connected to the
 * POS.  The POS says what to run; a person runs it and confirms (§2.9, §25).
 */
export class ManualExternalTerminalProvider implements PaymentTerminalProvider {
  async getStatus() {
    return status("not_configured", "External", "Card terminal is separate. Run the amount on it and confirm.");
  }

  async beginPayment(request: PaymentRequest): Promise<PaymentResult> {
    return {
      state: "awaiting_manual_confirmation",
      amountCents: request.amountCents,
      instructions: `Run ${dollars(request.amountCents)} on the card terminal for order ${request.orderNumber}.`,
    };
  }

  async cancelPayment() {
    // Nothing was sent anywhere, so there is nothing to cancel.
  }

  async getPaymentStatus() {
    return null;
  }

  async refund(request: PaymentRequest & { reason: string }): Promise<PaymentResult> {
    return {
      state: "awaiting_manual_confirmation",
      amountCents: request.amountCents,
      instructions: `Refund ${dollars(request.amountCents)} on the card terminal for order ${request.orderNumber}.`,
    };
  }
}
