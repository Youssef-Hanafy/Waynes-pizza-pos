import { logger } from "@/lib/logging/logger";
import { resolveWebhookProvider } from "@/lib/payments/config";
import { applyProviderWebhook } from "@/lib/payments/registry";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Stripe is the source of truth when a browser closes after authenticating a card. */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const resolved = await resolveWebhookProvider(request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? undefined);
  if (!resolved || resolved.connection.provider !== "stripe") return new Response(null, { status: 200 });

  const envelope = resolved.provider.handleWebhook({ rawBody, signature: request.headers.get("stripe-signature") });
  const supabase = createServiceSupabaseClient();
  const { data: recorded, error: recordError } = await supabase.rpc("hanafy_record_payment_webhook", {
    target_connection_id: resolved.connection.id,
    payload: { event_id: envelope.eventId || `unsigned-${crypto.randomUUID()}`, event_type: envelope.eventType, signature_verified: envelope.signatureVerified, payload: envelope.payload },
  });
  if (recordError) {
    logger.error("stripe_webhook.record_failed", new Error(recordError.message), { connection_id: resolved.connection.id });
    return new Response(null, { status: 500 });
  }
  const stored = recorded as { duplicate: boolean; id?: string } | null;
  if (!stored || stored.duplicate) return new Response(null, { status: 200 });
  if (!envelope.signatureVerified) {
    await supabase.rpc("wayne_finish_payment_webhook", { target_id: stored.id, error_message: "Signature did not verify" });
    logger.warn("stripe_webhook.bad_signature", { event_type: envelope.eventType });
    return new Response(null, { status: 200 });
  }
  try {
    await applyProviderWebhook(resolved.connection, supabase, envelope.eventType, envelope.payload);
    await supabase.rpc("wayne_finish_payment_webhook", { target_id: stored.id, error_message: null });
  } catch (cause) {
    logger.error("stripe_webhook.apply_failed", cause, { event_type: envelope.eventType });
    await supabase.rpc("wayne_finish_payment_webhook", { target_id: stored.id, error_message: cause instanceof Error ? cause.message : "Unknown error" });
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
}
