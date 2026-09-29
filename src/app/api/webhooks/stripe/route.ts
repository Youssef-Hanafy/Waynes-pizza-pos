import { logger } from "@/lib/logging/logger";
import { resolveWebhookProvider } from "@/lib/payments/config";
import { readStripeWebhookObject } from "@/lib/payments/stripe-mapping";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Stripe is the source of truth when a browser closes after authenticating a card. */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const resolved = await resolveWebhookProvider();
  if (!resolved || resolved.settings.provider !== "stripe") return new Response(null, { status: 200 });

  const envelope = resolved.provider.handleWebhook({ rawBody, signature: request.headers.get("stripe-signature") });
  const supabase = createServiceSupabaseClient();
  const { data: recorded } = await supabase.rpc("wayne_record_payment_webhook", {
    payload: { provider: "stripe", event_id: envelope.eventId || `unsigned-${crypto.randomUUID()}`, event_type: envelope.eventType, signature_verified: envelope.signatureVerified, payload: envelope.payload },
  });
  const stored = recorded as { duplicate: boolean; id?: string } | null;
  if (!stored || stored.duplicate) return new Response(null, { status: 200 });
  if (!envelope.signatureVerified) {
    await supabase.rpc("wayne_finish_payment_webhook", { target_id: stored.id, error_message: "Signature did not verify" });
    logger.warn("stripe_webhook.bad_signature", { event_type: envelope.eventType });
    return new Response(null, { status: 200 });
  }
  try {
    await applyEvent(supabase, envelope.eventType, envelope.payload);
    await supabase.rpc("wayne_finish_payment_webhook", { target_id: stored.id, error_message: null });
  } catch (cause) {
    logger.error("stripe_webhook.apply_failed", cause, { event_type: envelope.eventType });
    await supabase.rpc("wayne_finish_payment_webhook", { target_id: stored.id, error_message: cause instanceof Error ? cause.message : "Unknown error" });
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
}

type ServiceClient = ReturnType<typeof createServiceSupabaseClient>;
type Intent = {
  id?: string;
  status?: string;
  amount?: number;
  charges?: {
    data?: Array<{
      receipt_url?: string;
      payment_method_details?: { card?: { brand?: string; last4?: string } };
    }>;
  };
};

async function applyEvent(supabase: ServiceClient, eventType: string, payload: Record<string, unknown>) {
  if (!eventType.startsWith("payment_intent.")) return;
  const intent = readStripeWebhookObject(payload) as Intent;
  if (!intent.id) return;
  const status = intent.status === "succeeded" ? "captured" : intent.status === "requires_capture" ? "authorized" : intent.status === "canceled" ? "voided" : intent.status === "requires_payment_method" ? "failed" : "pending";
  if (status === "pending") return;
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
