import "server-only";
import { PaymentProviderError, type PaymentProvider } from "./provider";
import type { createServiceSupabaseClient } from "@/lib/supabase/server";
export type RefundLeg = {
  id: string; provider_payment_id: string; amount_cents: number; tip_cents: number;
  idempotency_key: string; reason: string; status: string; created_at: string;
};
/** No charge/capture calls exist here. Persist the allocation before reaching Stripe. */
export async function reconcileRefundLegs(service: ReturnType<typeof createServiceSupabaseClient>, provider: PaymentProvider, legs: RefundLeg[]) {
  if (provider.code !== "stripe" || !provider.findRefund) throw new Error("Refund recovery is not supported by this processor.");
  for (const leg of legs) {
    if (leg.status === "completed") continue;
    if (leg.status !== "pending") throw new Error("This refund leg failed. Review it before submitting another refund.");
    const input = { providerPaymentId: leg.provider_payment_id, amountCents: leg.amount_cents, idempotencyKey: leg.idempotency_key, reason: leg.reason };
    // Lookup failures are uncertainty: never mark failed or free the reservation.
    let refund = await provider.findRefund(input);
    if (!refund) {
      if (!Number.isFinite(Date.parse(leg.created_at)) || Date.now() - Date.parse(leg.created_at) > 23 * 60 * 60 * 1000) throw new Error("An older uncertain refund needs provider review; no new refund was sent.");
      try { refund = await provider.refundPayment(input); }
      catch (error) {
        if (error instanceof PaymentProviderError && !error.retryable) {
          const saved = await service.rpc("wayne_settle_refund", { payload: { refund_id: leg.id, status: "failed", failure_reason: error.message } });
          if (saved.error) throw new Error("The refund outcome could not be recorded. Resume this request.");
        }
        throw error;
      }
    }
    if (!refund.providerRefundId) throw new Error("The processor returned no refund identity. Resume this request.");
    if (refund.status === "pending") {
      const observed = await service.rpc("wayne_observe_refund", { payload: { refund_id: leg.id, provider_refund_id: refund.providerRefundId, provider_status: refund.providerStatus } });
      if (observed.error) throw new Error("The pending refund reference was not saved. Resume this request.");
      return { pending: true };
    }
    const settled = await service.rpc("wayne_settle_refund", { payload: { refund_id: leg.id, status: refund.status, provider_refund_id: refund.providerRefundId, provider_status: refund.providerStatus, failure_reason: refund.failureReason } });
    if (settled.error) throw new Error("Stripe answered but the receipt was not saved. Resume this request; do not submit a new refund.");
    if (refund.status !== "completed") throw new Error("The processor rejected this refund. Review the recorded outcome.");
  }
  return { pending: false };
}
