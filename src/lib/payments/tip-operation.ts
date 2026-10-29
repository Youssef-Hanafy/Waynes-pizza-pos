import "server-only";
import { randomUUID } from "node:crypto";
import type { createServiceSupabaseClient } from "@/lib/supabase/server";
import { PaymentProviderError, type PaymentProvider, type ProviderPayment } from "./provider";
import type { TipCapture } from "./tip-capture";

type Service = ReturnType<typeof createServiceSupabaseClient>;
type Plan = { mode: "capture" | "replacement" | "test"; amount_cents: number; fallback_amount_cents: number; customer_id?: string; payment_method_id?: string };
type Operation = {
  id: string; original_provider_id: string | null; authorized_cents: number; requested_tip_cents: number;
  state: "pending" | "succeeded"; plan: Plan | null; replacement_id: string | null;
  fallback_to_capture: boolean; result: TipCapture | null; release_pending: boolean;
};
type Payment = { id: string; provider: string; card_brand: string | null; card_last4: string | null; metadata: Record<string, unknown> };
const uncertain = () => new PaymentProviderError("This payment is still being reconciled. Retry this operation; do not charge the customer another way.", "TIP_UNCERTAIN", true);

/** A durable receipt, not the request's screen or newly entered amount, owns retries. */
export async function runTipOperation(options: {
  service: Service; payment: Payment; workspaceId: string; wanted: number; origin: string;
  provider: () => Promise<PaymentProvider>; testTipRoom: number;
}): Promise<{ capture: TipCapture; problems: string[] }> {
  const { service, payment } = options;
  const token = randomUUID();
  const { data, error } = await service.rpc("wayne_claim_tip_operation", {
    target_payment_id: payment.id, target_workspace_id: options.workspaceId, requested_tip: options.wanted,
    worker_token: token, origin: options.origin,
  });
  if (error) throw new PaymentProviderError("The tip operation could not be reserved. No new charge was requested.", "DATABASE", true);
  const claim = data as { acquired: boolean; disabled?: boolean; execution_enabled?: boolean; operation?: Operation };
  if (!claim.acquired || !claim.operation) throw new PaymentProviderError(claim.disabled ? "Tip capture is paused for maintenance." : "Another request owns this payment, or it is already settled. Refresh before retrying.", "TIP_BUSY", true);
  let op = claim.operation;
  const problems: string[] = [];
  const update = async (action: string, details: Record<string, unknown> = {}) => {
    const { data, error } = await service.rpc("wayne_update_tip_operation", { target_operation_id: op.id, worker_token: token, action, details });
    if (error || !data) throw new PaymentProviderError("The tip operation could not be saved. Its outcome must be reconciled before another charge.", "DATABASE", true);
    op = data as Operation;
  };
  let api: PaymentProvider | undefined;
  const provider = async () => (api ??= await options.provider());
  const finish = async (answer: ProviderPayment) => {
    if (answer.status !== "captured" || !answer.amountCents) throw uncertain();
    const { data, error } = await service.rpc("wayne_complete_tip_operation", {
      target_operation_id: op.id, provider_id: answer.providerPaymentId,
      captured_cents: answer.amountCents, card_brand: answer.cardBrand, card_last4: answer.cardLast4,
    });
    if (error || !data) throw new PaymentProviderError("The provider approved this charge, but the database has not acknowledged it. Retry to reconcile; do not charge again.", "DATABASE", true);
    op = { ...op, state: "succeeded", result: data as TipCapture, release_pending: op.plan?.mode === "replacement" && !op.fallback_to_capture };
  };
  const releaseOriginal = async () => {
    if (!op.release_pending || !op.original_provider_id || !op.replacement_id) return;
    try {
      const stripe = await provider();
      const status = await stripe.getPaymentStatus(op.original_provider_id);
      if (status.status !== "voided") {
        if (!stripe.releaseHold) throw uncertain();
        const canceled = await stripe.releaseHold(op.original_provider_id, op.replacement_id);
        if (canceled.status !== "voided") throw uncertain();
      }
      await update("hold_released");
    } catch {
      problems.push("The charge is recorded, but release of the original authorization is still pending. Recovery will retry the release, not the charge.");
    }
  };
  try {
    if (op.state !== "succeeded") {
      if (!op.plan) {
        if (!claim.execution_enabled) throw uncertain();
        let plan: Plan;
        if (payment.provider === "test") {
          const amount = op.authorized_cents + Math.min(op.requested_tip_cents, options.testTipRoom);
          plan = { mode: "test", amount_cents: amount, fallback_amount_cents: amount };
        } else {
          if (!op.original_provider_id) throw uncertain();
          const stripe = await provider();
          const original = await stripe.getPaymentStatus(op.original_provider_id);
          if (original.status !== "authorized" && original.status !== "captured") throw uncertain();
          const room = Math.max(0, (original.maxCapturableCents ?? op.authorized_cents) - op.authorized_cents);
          const fallback = op.authorized_cents + Math.min(op.requested_tip_cents, room);
          const replacement = original.status === "authorized" && op.requested_tip_cents > room && stripe.createSavedCardIntent && stripe.confirmSavedCardIntent && stripe.releaseHold && original.paymentMethodId && original.customerId;
          plan = {
            mode: replacement ? "replacement" : "capture",
            amount_cents: original.status === "captured" ? original.amountCents! : replacement ? op.authorized_cents + op.requested_tip_cents : fallback,
            fallback_amount_cents: original.status === "captured" ? original.amountCents! : fallback,
            ...(replacement ? { customer_id: original.customerId!, payment_method_id: original.paymentMethodId! } : {}),
          };
        }
        await update("plan", plan);
      }
      const plan = op.plan!;
      if (plan.mode === "test") {
        if (!claim.execution_enabled) throw uncertain();
        await finish({ providerPaymentId: op.original_provider_id, status: "captured", providerStatus: "succeeded", amountCents: plan.amount_cents, cardBrand: payment.card_brand ?? "test", cardLast4: payment.card_last4 ?? "4242", receiptUrl: null, failureReason: null });
      } else {
        const stripe = await provider();
        if (plan.mode === "replacement" && !op.fallback_to_capture) {
          if (!op.replacement_id) {
            if (!claim.execution_enabled || !stripe.createSavedCardIntent) throw uncertain();
            // No confirm=true here: even a create-response lost for >24 hours
            // can only leave an uncharged orphan. Only the persisted ID may charge.
            const prepared = await stripe.createSavedCardIntent({
              customerId: plan.customer_id!, paymentMethodId: plan.payment_method_id!, amountCents: plan.amount_cents,
              idempotencyKey: `tip-${op.id}-prepare`, note: `POS tip operation ${op.id}`,
              metadata: { wayne_payment_id: payment.id, wayne_tip_adjust: "true", wayne_tip_operation: op.id, wayne_replaces: op.original_provider_id! },
            });
            if (!prepared.providerPaymentId || prepared.status === "captured") throw uncertain();
            await update("bind", { provider_id: prepared.providerPaymentId });
          }
          let replacement = await stripe.getPaymentStatus(op.replacement_id!);
          if (replacement.providerStatus === "requires_confirmation") {
            if (!claim.execution_enabled || !stripe.confirmSavedCardIntent) throw uncertain();
            try { replacement = await stripe.confirmSavedCardIntent(op.replacement_id!, `tip-${op.id}-confirm`); }
            catch { replacement = await stripe.getPaymentStatus(op.replacement_id!); }
          }
          if (replacement.status === "captured") {
            await finish(replacement);
          } else if (replacement.status === "failed" || replacement.status === "voided") {
            if (!claim.execution_enabled) throw uncertain();
            // A decline is not permission to create another charge. Cancel the
            // bound intent first; a delayed confirmation then cannot succeed.
            const canceled = replacement.status === "voided" ? replacement : await stripe.voidPayment(op.replacement_id!);
            if (canceled.status !== "voided") throw uncertain();
            await update("fallback", { canceled_id: op.replacement_id });
          } else {
            throw uncertain(); // processing, requires_action, unknown: no original capture/release
          }
        }
        if (!op.result && (plan.mode === "capture" || op.fallback_to_capture)) {
          let original = await stripe.getPaymentStatus(op.original_provider_id!);
          if (original.status !== "captured") {
            if (!claim.execution_enabled || original.status !== "authorized") throw uncertain();
            const amount = op.fallback_to_capture ? plan.fallback_amount_cents : plan.amount_cents;
            try { original = await stripe.capturePayment(op.original_provider_id!, { amountCents: amount, idempotencyKey: `tip-${op.id}-capture` }); }
            catch { original = await stripe.getPaymentStatus(op.original_provider_id!); }
          }
          await finish(original);
        }
      }
    }
    if (!op.result) throw uncertain();
    await releaseOriginal();
    if (op.result.tip_cents !== options.wanted) problems.push(`This payment's recorded tip is $${(op.result.tip_cents / 100).toFixed(2)}; the newly requested $${(options.wanted / 100).toFixed(2)} was not charged. A retry cannot change an operation already sent to the provider.`);
    return { capture: op.result, problems };
  } finally {
    // Losing this response leaves a lease, not permission to start a second
    // financial operation. After expiry a worker resumes the same saved plan/ID.
    try { await service.rpc("wayne_update_tip_operation", { target_operation_id: op.id, worker_token: token, action: "release", details: {} }); }
    catch { /* A lost release acknowledgment is recovered by lease expiry. */ }
  }
}
