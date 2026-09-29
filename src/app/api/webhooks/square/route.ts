import { logger } from "@/lib/logging/logger";
import { resolveWebhookProvider } from "@/lib/payments/config";
import { applySquareWebhookEvent } from "@/lib/payments/square-webhook";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Square tells us what really happened. This endpoint is the authority when the
 * browser and the provider disagree: an order paid after the customer closed the tab,
 * a reader that completed after the counter gave up, a refund that settled later.
 *
 * Every event is stored once by its provider event id, so a duplicate delivery — which
 * Square explicitly does send — changes nothing the second time. An unsigned or
 * wrongly signed body is recorded for the reconciliation screen and then ignored.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-square-hmacsha256-signature");

  const resolved = await resolveWebhookProvider(request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? undefined);
  if (!resolved) {
    logger.warn("square_webhook.unconfigured", { length: rawBody.length });
    // 200 so Square stops retrying into a deployment that has no processor at all.
    return new Response(null, { status: 200 });
  }

  const envelope = resolved.provider.handleWebhook({ rawBody, signature });
  const supabase = createServiceSupabaseClient();
  const { data: recorded } = await supabase.rpc("wayne_record_payment_webhook", {
    payload: {
      provider: "square",
      event_id: envelope.eventId || `unsigned-${crypto.randomUUID()}`,
      event_type: envelope.eventType,
      signature_verified: envelope.signatureVerified,
      payload: envelope.payload,
    },
  });
  const stored = recorded as { duplicate: boolean; id?: string } | null;
  if (!stored || stored.duplicate) return new Response(null, { status: 200 });

  if (!envelope.signatureVerified) {
    logger.warn("square_webhook.bad_signature", { event_type: envelope.eventType });
    await supabase.rpc("wayne_finish_payment_webhook", { target_id: stored.id, error_message: "Signature did not verify" });
    return new Response(null, { status: 200 });
  }

  try {
    await applySquareWebhookEvent(supabase, envelope.eventType, envelope.payload);
    await supabase.rpc("wayne_finish_payment_webhook", { target_id: stored.id, error_message: null });
  } catch (cause) {
    logger.error("square_webhook.apply_failed", cause, { event_type: envelope.eventType });
    await supabase.rpc("wayne_finish_payment_webhook", {
      target_id: stored.id,
      error_message: cause instanceof Error ? cause.message : "Unknown error",
    });
    // 500 asks Square to retry; the event id keeps the retry harmless.
    return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 200 });
}
