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
