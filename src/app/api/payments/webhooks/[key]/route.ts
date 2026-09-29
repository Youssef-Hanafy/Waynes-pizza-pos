import { logger } from "@/lib/logging/logger";
import { paymentConnectionSchema } from "@/lib/payments/capabilities";
import { applyProviderWebhook, buildWebhookProvider, webhookSignature } from "@/lib/payments/registry";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Per-connection payment webhooks (Phase 9).  The URL's key identifies ONE
 * payment connection, so the business is known before the body is read, the
 * connection's own signing secret verifies it, and the event is stored
 * against that business.  Provider webhooks arrive on the platform host, so
 * host-based routing is not used here.
 */
export async function POST(request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  if (!/^[0-9a-f]{24,64}$/.test(key)) return new Response(null, { status: 404 });
  const rawBody = await request.text();
  const supabase = createServiceSupabaseClient();

  const { data, error } = await supabase.rpc("hanafy_payment_connection_by_webhook_key", { target_key: key });
  const parsed = paymentConnectionSchema.safeParse(data);
  if (error || !parsed.success) return new Response(null, { status: 404 });
  const connection = parsed.data;
  const provider = buildWebhookProvider(connection);
  if (!provider) {
    logger.warn("payment_webhook.unavailable", { connection_id: connection.id, provider: connection.provider });
    return new Response(null, { status: 200 });
  }

  const signature = webhookSignature(connection, request.headers);
  const envelope = provider.handleWebhook({ rawBody, signature });
  const { data: recorded, error: recordError } = await supabase.rpc("hanafy_record_payment_webhook", {
    target_connection_id: connection.id,
    payload: {
      event_id: envelope.eventId || `unsigned-${crypto.randomUUID()}`,
      event_type: envelope.eventType,
      signature_verified: envelope.signatureVerified,
      payload: envelope.payload,
    },
  });
  if (recordError) {
    logger.error("payment_webhook.record_failed", new Error(recordError.message), { connection_id: connection.id });
    return new Response(null, { status: 500 });
  }
  const stored = recorded as { duplicate: boolean; id?: string } | null;
  if (!stored || stored.duplicate || !stored.id) return new Response(null, { status: 200 });

  if (!envelope.signatureVerified) {
    logger.warn("payment_webhook.bad_signature", { connection_id: connection.id, event_type: envelope.eventType });
    await supabase.rpc("wayne_finish_payment_webhook", { target_id: stored.id, error_message: "Signature did not verify" });
    return new Response(null, { status: 200 });
  }
  try {
    await applyProviderWebhook(connection, supabase, envelope.eventType, envelope.payload);
    await supabase.rpc("wayne_finish_payment_webhook", { target_id: stored.id, error_message: null });
  } catch (cause) {
    logger.error("payment_webhook.apply_failed", cause, { connection_id: connection.id, event_type: envelope.eventType });
    await supabase.rpc("wayne_finish_payment_webhook", { target_id: stored.id, error_message: cause instanceof Error ? cause.message : "Unknown error" });
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
}
