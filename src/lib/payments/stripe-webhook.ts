import { readStripeWebhookObject } from "./stripe-mapping";
import type { ServiceClient } from "./square-webhook";

type Intent = {
  id?: string;
  status?: string;
  amount?: number;
  metadata?: Record<string, string>;
  charges?: { data?: Array<{ receipt_url?: string; payment_method_details?: { card?: { brand?: string; last4?: string } } }> };
};

/** Settles a verified Stripe PaymentIntent without trusting browser input. */
export async function applyStripeWebhookEvent(supabase: ServiceClient, eventType: string, payload: Record<string, unknown>) {
  if (!eventType.startsWith("payment_intent.")) return;
  const intent = readStripeWebhookObject(payload) as Intent;
  if (!intent.id) return;
  const status = intent.status === "succeeded" ? "captured" : intent.status === "requires_capture" ? "authorized" : intent.status === "canceled" ? "voided" : intent.status === "requires_payment_method" ? "failed" : "pending";
  if (status === "pending") return;
  // A card declined on the Stripe M2 goes back to "requires_payment_method" and
  // the same intent takes the next card; it is not a failed payment (the POS
  // cancels it if the customer pays another way).
  if (status === "failed" && intent.metadata?.wayne_entry === "terminal") return;
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
