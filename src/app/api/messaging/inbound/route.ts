import { logger } from "@/lib/logging/logger";
import { allowedTopics, isTrustedSnsUrl, parseSnsMessage, readSmsPayload, verifySnsMessage } from "@/lib/messaging/sns";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Inbound texts and delivery receipts from AWS End User Messaging, via an SNS
 * HTTPS subscription (Phase 7).  Only signed messages from an expected topic
 * are used.  The receiving number decides the business, so a STOP sent to one
 * business's number never touches another business.
 *
 * Wayne's number still reports to the old Hanafy CRM until its cut-over; point
 * a topic here only for businesses whose messaging is on the platform sender.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return Response.json({ error: "Invalid body." }, { status: 400 });
  }
  const message = parseSnsMessage(body);
  if (!message) return Response.json({ error: "Not an SNS message." }, { status: 400 });
  if (!allowedTopics().includes(message.TopicArn)) {
    logger.warn("messaging.inbound_unexpected_topic", { topic: message.TopicArn.slice(0, 200) });
    return Response.json({ error: "Unknown topic." }, { status: 403 });
  }
  if (!(await verifySnsMessage(message))) {
    logger.warn("messaging.inbound_bad_signature", { message_id: message.MessageId });
    return Response.json({ error: "Signature did not verify." }, { status: 403 });
  }

  if (message.Type === "SubscriptionConfirmation") {
    if (!message.SubscribeURL || !isTrustedSnsUrl(message.SubscribeURL)) return Response.json({ error: "Bad subscribe URL." }, { status: 400 });
    const response = await fetch(message.SubscribeURL, { signal: AbortSignal.timeout(10_000) });
    return Response.json({ confirmed: response.ok }, { status: response.ok ? 200 : 502 });
  }
  if (message.Type === "UnsubscribeConfirmation") return new Response(null, { status: 200 });

  const payload = readSmsPayload(message.Message);
  const supabase = createServiceSupabaseClient();
  if (payload.kind === "inbound") {
    const { data, error } = await supabase.rpc("hanafy_messaging_inbound", {
      destination_number: payload.value.destinationNumber,
      sender_number: payload.value.originationNumber,
      message_body: payload.value.messageBody,
      provider_event_value: payload.value.inboundMessageId ?? message.MessageId,
    });
    if (error) {
      logger.error("messaging.inbound_failed", new Error(error.message));
      return Response.json({ error: "Could not record the message." }, { status: 500 });
    }
    return Response.json(data ?? {}, { headers: { "Cache-Control": "no-store" } });
  }
  if (payload.kind === "delivery") {
    const { error } = await supabase.rpc("hanafy_message_delivery_status", {
      provider_value: "aws_end_user_messaging",
      provider_event_value: payload.value.eventId,
      provider_message_value: payload.value.messageId,
      status_value: payload.value.messageStatus,
    });
    if (error) {
      logger.error("messaging.receipt_failed", new Error(error.message));
      return Response.json({ error: "Could not record the receipt." }, { status: 500 });
    }
    return new Response(null, { status: 200 });
  }
  return new Response(null, { status: 200 });
}
