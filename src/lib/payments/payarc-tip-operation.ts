import "server-only";
import type { createServiceSupabaseClient } from "@/lib/supabase/server";
import { PaymentProviderError, type PaymentProvider, type ProviderPayment } from "./provider";
import type { TipCapture } from "./tip-capture";

type Operation = { id: string; payment_id: string; order_id: string; provider_payment_id: string; extra_tip_cents: number; target_amount_cents: number; target_tip_cents: number; state: "pending" | "succeeded" };
const observation = (p: ProviderPayment) => ({ provider_payment_id: p.providerPaymentId, status: p.status, provider_status: p.providerStatus, amount_cents: p.amountCents, tip_amount: p.tipAmountCents });
const matches = (op: Operation, p: ProviderPayment) => p.providerPaymentId === op.provider_payment_id && p.status === "captured" && p.amountCents === op.target_amount_cents && p.tipAmountCents === op.target_tip_cents;

/** No fallback charge exists. After submission, retries only read the same charge. */
export async function runPayarcTipOperation(options: {
  service: ReturnType<typeof createServiceSupabaseClient>; workspaceId: string;
  paymentId: string; providerPaymentId: string; extraCents: number; provider: PaymentProvider;
}): Promise<TipCapture> {
  const { service, provider } = options;
  if (provider.code !== "payarc" || !provider.adjustTip) throw new PaymentProviderError("Payarc tip adjustment is not configured.", "NOT_CONFIGURED");
  let current = await provider.getPaymentStatus(options.providerPaymentId);
  const claim = await service.rpc("wayne_claim_payarc_tip", { target_payment_id: options.paymentId, target_workspace_id: options.workspaceId, extra_tip: options.extraCents, observed: observation(current) });
  if (claim.error || !claim.data) throw new PaymentProviderError(claim.error?.message ?? "The Payarc tip request could not be saved.", "TIP_RESERVATION", true);
  const op = claim.data as Operation;
  if (op.state === "succeeded" && !matches(op, current)) throw new PaymentProviderError("The completed Payarc tip no longer matches the charge. Review this payment before cash-out.", "TIP_CONFLICT", true);
  if (op.state !== "succeeded") {
    if (!matches(op, current) && op.extra_tip_cents > 0) {
      const submission = await service.rpc("wayne_submit_payarc_tip", { target_operation_id: op.id });
      if (submission.error) throw new PaymentProviderError("The Payarc tip reservation could not be checked. Check this same request again.", "DATABASE", true);
      if (submission.data === true) {
        // A POST response (even 200) is insufficient. The adapter re-reads; after
        // any lost/rejected response, another GET may recover the exact outcome.
        try { current = await provider.adjustTip(op.provider_payment_id, { tipCents: op.target_tip_cents, idempotencyKey: `payarc-tip-${op.id}` }); }
        catch { current = await provider.getPaymentStatus(op.provider_payment_id); }
      } else current = await provider.getPaymentStatus(op.provider_payment_id);
    }
    if (!matches(op, current)) throw new PaymentProviderError("Payarc has not confirmed the saved extra tip and total. Do not charge another card. Check this request again or review Payarc's batch/decline status.", "TIP_UNCONFIRMED", true);
    const completed = await service.rpc("wayne_complete_payarc_tip", { target_operation_id: op.id, observed: observation(current) });
    if (completed.error) throw new PaymentProviderError("Payarc answered, but the tip receipt needs recovery. Check this same request again before paying the driver.", "DATABASE", true);
  }
  return { order_id: op.order_id, payment_id: op.payment_id, captured_cents: op.target_amount_cents, tip_cents: op.extra_tip_cents,
    provider_payment_id: op.provider_payment_id, card_brand: current.cardBrand, card_last4: current.cardLast4 };
}
