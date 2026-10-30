import { readStripeWebhookObject } from "./stripe-mapping";
import type { ServiceClient } from "./square-webhook";

/** A signed duplicate is a safe opportunity to retry an authoritative read. */
export function isStripePaymentIntentWebhook(eventType: string, payload: Record<string, unknown>) {
  return eventType.startsWith("payment_intent.") && typeof readStripeWebhookObject(payload).id === "string";
}

/** Events are notifications, never state snapshots to write to the ledger. */
export async function applyStripeWebhookEvent(
  supabase: ServiceClient, eventType: string, payload: Record<string, unknown>,
  workspaceId: string | undefined,
  readPayment: (id: string) => Promise<import("./provider").ProviderPayment>,
) {
  if (!isStripePaymentIntentWebhook(eventType, payload)) return;
  if (!workspaceId) throw new Error("Stripe webhook has no workspace scope");
  const eventIntent = readStripeWebhookObject(payload) as { id: string };
  const current = await readPayment(eventIntent.id);
  if (current.providerPaymentId !== eventIntent.id) throw new Error("Stripe returned a different payment identity");
  if (current.status === "pending") return;
  // The M2 may reuse a declined, still-unconfirmed intent for the next card.
  if (current.status === "failed" && (!current.failureReason || current.metadata?.wayne_entry === "terminal")) return;
  // A newly created intent awaiting its first card is not a declined payment.
  // Preserve legacy hold-release handling, using current metadata rather than
  // a historical event's marker.
  if (current.metadata?.wayne_replaced_by) return;
  const { data, error } = await supabase.rpc("wayne_settle_stripe_payment", {
    target_workspace_id: workspaceId,
    payload: {
      provider_payment_id: current.providerPaymentId, status: current.status,
      provider_status: current.providerStatus, amount_cents: current.amountCents,
      card_brand: current.cardBrand, card_last4: current.cardLast4, receipt_url: current.receiptUrl,
      failure_reason: current.failureReason,
      tip_operation_id: current.metadata?.wayne_tip_operation,
      tip_adjust: current.metadata?.wayne_tip_adjust === "true",
    },
  });
  if (error) throw new Error(error.message);
  const outcome = data as { reconciled?: boolean; deferred?: boolean; operation_id?: string } | null;
  const boundDeferred = current.status !== "captured" && outcome?.deferred && outcome.operation_id === current.metadata?.wayne_tip_operation;
  if (current.metadata?.wayne_tip_operation && !outcome?.reconciled && !boundDeferred) {
    throw new Error("Tip operation is not yet bound; retry reconciliation");
  }
}

/** Refund duplicates re-read Stripe; webhook payload status is never authoritative. */
export function isStripeRefundWebhook(eventType: string, payload: Record<string, unknown>) {
  return eventType.startsWith("refund.") && typeof readStripeWebhookObject(payload).id === "string";
}
export function isStripeReconciliationWebhook(eventType: string, payload: Record<string, unknown>) {
  return isStripePaymentIntentWebhook(eventType, payload) || isStripeRefundWebhook(eventType, payload);
}
export async function applyStripeRefundWebhook(
  supabase: ServiceClient, eventType: string, payload: Record<string, unknown>, workspaceId: string,
  provider: import("./provider").PaymentProvider,
) {
  if (!isStripeRefundWebhook(eventType, payload)) return;
  const object = readStripeWebhookObject(payload) as { metadata?: Record<string,string> };
  const key = object.metadata?.wayne_refund_leg;
  if (!key) return; // External/manual refunds require separate ledger reconciliation.
  const { data: leg, error } = await supabase.from("refunds").select("id,provider_payment_id,amount_cents,idempotency_key,status")
    .eq("workspace_id", workspaceId).eq("idempotency_key",key).maybeSingle();
  if (error || !leg || !provider.findRefund) throw new Error("Refund leg is not bound; retry reconciliation");
  const current = await provider.findRefund({ providerPaymentId: leg.provider_payment_id, amountCents: leg.amount_cents, idempotencyKey: leg.idempotency_key });
  if (!current?.providerRefundId) throw new Error("Refund outcome is uncertain; retry reconciliation");
  if (current.status === "pending") {
    const observed = await supabase.rpc("wayne_observe_refund", { payload: { refund_id: leg.id, provider_refund_id: current.providerRefundId, provider_status: current.providerStatus } });
    if (observed.error) throw new Error(observed.error.message);
    return;
  }
  const settled = await supabase.rpc("wayne_settle_refund", { payload: { refund_id: leg.id, status: current.status, provider_refund_id: current.providerRefundId, provider_status: current.providerStatus, failure_reason: current.failureReason } });
  if (settled.error) throw new Error(settled.error.message);
}
