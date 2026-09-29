import { logger } from "@/lib/logging/logger";
import { checkoutRateLimitKey } from "@/lib/orders/rate-limit";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { PaymentProviderError } from "@/lib/payments/provider";
import { stripeIntentRequestSchema } from "@/lib/payments/schemas";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { tryGetServerSupabaseEnvironment } from "@/lib/supabase/env";

/**
 * Creates a held order and its Stripe PaymentIntent before the browser submits a
 * card. The amount comes only from the database; the browser cannot choose it.
 */
export async function POST(request: Request) {
  const parsed = stripeIntentRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the order details." }, { status: 400 });
  if (!tryGetServerSupabaseEnvironment()) return unavailable();

  const resolved = await resolvePaymentProvider("online");
  if (!resolved.ok || resolved.value.provider.code !== "stripe") return unavailable();
  const supabase = createServiceSupabaseClient();
  const { data: allowed, error: rateLimitError } = await supabase.rpc("wayne_consume_public_order_rate_limit", { client_key: checkoutRateLimitKey(request.headers) });
  if (rateLimitError) logger.error("stripe_intent.rate_limit_unavailable", new Error(rateLimitError.message), { code: rateLimitError.code });
  if (rateLimitError || allowed !== true) return Response.json({ error: "Too many order attempts. Please wait a few minutes and try again." }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "300" } });

  const { data: orderData, error: orderError } = await supabase.rpc("wayne_create_card_order", { payload: parsed.data });
  if (orderError || !orderData) return Response.json({ error: customerSafeOrderError(orderError?.message ?? "") }, { status: 400 });
  const order = orderData as { id: string; public_access_token: string; order_number: string; total_cents: number };
  const { data: beginData, error: beginError } = await supabase.rpc("wayne_begin_payment", {
    payload: { order_id: order.id, idempotency_key: parsed.data.idempotency_key, entry: "online", method: "card" },
  });
  if (beginError || !beginData) return Response.json({ error: "That payment is already being processed. Check your order before trying again." }, { status: 409 });
  const begun = beginData as { payment_id: string; duplicate: boolean; status: string };

  try {
    let intent;
    if (begun.duplicate) {
      const { data: payment } = await supabase.from("payments").select("provider_payment_id, status").eq("id", begun.payment_id).maybeSingle();
      if (!payment?.provider_payment_id) return Response.json({ error: "That payment is still being prepared. Please wait a moment and check your order." }, { status: 409 });
      intent = await resolved.value.provider.getOnlinePaymentIntent(payment.provider_payment_id);
    } else {
      intent = await resolved.value.provider.createOnlinePaymentIntent({
        amountCents: order.total_cents,
        idempotencyKey: parsed.data.idempotency_key,
        referenceId: order.order_number,
        note: `Wayne's Pizza order ${order.order_number}`,
        paymentId: begun.payment_id,
        receiptEmail: parsed.data.email || null,
      });
      const { error } = await supabase.from("payments").update({ provider_payment_id: intent.providerPaymentId, provider_status: intent.providerStatus }).eq("id", begun.payment_id);
      if (error) throw new PaymentProviderError("The payment could not be prepared. Please try again.", "DATABASE", true);
    }
    return Response.json({
      id: order.id, public_access_token: order.public_access_token, order_number: order.order_number, total_cents: order.total_cents,
      payment_id: begun.payment_id, provider_payment_id: intent.providerPaymentId, client_secret: intent.clientSecret,
      payment_status: intent.status === "captured" ? "captured" : "pending",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    const error = cause instanceof PaymentProviderError ? cause : null;
    logger.error("stripe_intent.create_failed", cause, { order_id: order.id, code: error?.code });
    return Response.json({ error: error?.retryable ? "The card network did not answer. Please check your order before trying again." : error?.message ?? "The payment could not be prepared. Please try again." }, { status: error?.retryable ? 502 : 400, headers: { "Cache-Control": "no-store" } });
  }
}

function unavailable() {
  return Response.json({ error: "Online card payment is not available right now. Please call Wayne's Pizza." }, { status: 503, headers: { "Cache-Control": "no-store" } });
}

function customerSafeOrderError(message: string) {
  const expected = ["currently closed", "currently unavailable", "unavailable right now", "Choose", "required", "valid", "minimum", "modifier", "variant", "Cart", "quantity", "Promotion", "Tip", "Test ordering", "switched on"];
  return expected.some((part) => message.includes(part)) ? message : "The order could not be placed. Please review it and try again.";
}
