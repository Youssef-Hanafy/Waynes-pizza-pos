import { readStripeWebhookObject } from "./stripe-mapping";
import type { ServiceClient } from "./square-webhook";

type Intent = {
  id?: string;
  status?: string;
  amount?: number;
  amount_received?: number;
  metadata?: Record<string, string>;
  charges?: { data?: Array<{ receipt_url?: string; payment_method_details?: { card?: { brand?: string; last4?: string } } }> };
};

/** Only verified tip-success events may bypass the legacy duplicate guard. */
export function isTipSuccessWebhook(eventType: string, payload: Record<string, unknown>) {
  const intent = readStripeWebhookObject(payload) as Intent;
  return eventType === "payment_intent.succeeded" && intent.status === "succeeded"
    && (intent.metadata?.wayne_tip_adjust === "true" || Boolean(intent.metadata?.wayne_tip_operation));
}

/** Settles a verified Stripe PaymentIntent without trusting browser input. */
export async function applyStripeWebhookEvent(supabase: ServiceClient, eventType: string, payload: Record<string, unknown>, workspaceId?: string) {
  if (!eventType.startsWith("payment_intent.")) return;
  const intent = readStripeWebhookObject(payload) as Intent;
  if (!intent.id) return;
  const status = intent.status === "succeeded" ? "captured" : intent.status === "requires_capture" ? "authorized" : intent.status === "canceled" ? "voided" : intent.status === "requires_payment_method" ? "failed" : "pending";
  if (status === "pending") return;
  // A card declined on the Stripe M2 goes back to "requires_payment_method" and
  // the same intent takes the next card; it is not a failed payment (the POS
  // cancels it if the customer pays another way).
  if (status === "failed" && intent.metadata?.wayne_entry === "terminal") return;
  // Recover even when the request died after Stripe succeeded. SQL matches
  // the stored intent, workspace and frozen amount; repeated events are safe.
  if (isTipSuccessWebhook(eventType, payload)) {
    if (!workspaceId) throw new Error("Tip webhook has no workspace scope");
    const card = intent.charges?.data?.[0]?.payment_method_details?.card;
    const { data, error } = await supabase.rpc("wayne_reconcile_tip_webhook", {
      target_workspace_id: workspaceId, provider_id: intent.id,
      captured_cents: intent.amount_received ?? intent.amount ?? null,
      card_brand: card?.brand ?? null, card_last4: card?.last4 ?? null,
    });
    if (error) throw new Error(error.message);
    if (!data && intent.metadata?.wayne_tip_operation) throw new Error("Tip operation is not yet bound; retry reconciliation");
    // Legacy held intents without a durable operation keep their existing behavior.
    return;
  }
  // An approval replaced at cash-out by one charge for order + tip: the payment
  // now points at the new charge, so this cancellation must not void it.
  if (intent.metadata?.wayne_replaced_by) return;
  const card = intent.charges?.data?.[0]?.payment_method_details?.card;
  const { error } = await supabase.rpc("wayne_settle_payment", {
    payload: {
      provider_payment_id: intent.id, status, provider_status: intent.status ?? "", amount_cents: intent.amount ?? null,
      card_brand: card?.brand ?? null, card_last4: card?.last4 ?? null, receipt_url: intent.charges?.data?.[0]?.receipt_url ?? null,
      failure_reason: eventType === "payment_intent.payment_failed" ? "The card was declined. Try another card." : null,
      metadata: { source: "stripe_webhook" },
    },
  });
  if (error && error.code !== "P0002") throw new Error(error.message);
}
