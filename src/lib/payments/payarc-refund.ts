import "server-only";
import type { createServiceSupabaseClient } from "@/lib/supabase/server";
import { PaymentProviderError, type PaymentProvider } from "./provider";
import type { RefundLeg } from "./refund-operation";

export async function reconcilePayarcRefunds(service: ReturnType<typeof createServiceSupabaseClient>, provider: PaymentProvider, legs: RefundLeg[]) {
  if (provider.code !== "payarc" || !provider.findRefund) throw new Error("Payarc refund configuration is unavailable.");
  for (const leg of legs) {
    if (leg.status === "completed") continue;
    if (leg.status !== "pending") throw new Error("Review the existing refund outcome before submitting another refund.");
    const input = { providerPaymentId: leg.provider_payment_id, amountCents: leg.amount_cents, idempotencyKey: leg.idempotency_key, reason: leg.reason };
    let refund = await provider.findRefund(input);
    if (!refund) {
      const payment = await provider.getPaymentStatus(leg.provider_payment_id);
      if (!["settled", "partially_refunded"].includes(payment.providerStatus)) throw new Error("Payarc has not confirmed this charge is batched. Use Void for an unbatched payment; do not issue a second charge.");
      const claimed = await service.rpc("wayne_claim_payarc_refund", { target_refund_id: leg.id });
      if (claimed.error || claimed.data !== true) throw new Error("This refund may already have been submitted. Check Payarc; this request only rechecks its existing refund.");
      try { refund = await provider.refundPayment(input); }
      catch (error) {
        if (error instanceof PaymentProviderError && !error.retryable) {
          const failed = await service.rpc("wayne_settle_refund", { payload: { refund_id: leg.id, status: "failed", failure_reason: error.message } });
          if (failed.error) throw new Error("The refund outcome needs review in Payarc.");
        }
        throw error;
      }
    }
    if (!refund.providerRefundId) throw new Error("The refund identity needs review in Payarc.");
    const saved = await service.rpc(refund.status === "pending" ? "wayne_observe_refund" : "wayne_settle_refund", { payload: {
      refund_id: leg.id, provider_refund_id: refund.providerRefundId, provider_status: refund.providerStatus, status: refund.status,
    } });
    if (saved.error) throw new Error("The refund receipt needs recovery. Resume this same request.");
    if (refund.status === "pending") return { pending: true };
    if (refund.status !== "completed") throw new Error("Payarc did not complete this refund. Review its recorded outcome.");
  }
  return { pending: false };
}
