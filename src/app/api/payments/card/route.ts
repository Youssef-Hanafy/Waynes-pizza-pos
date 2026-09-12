import { logger } from "@/lib/logging/logger";
import { checkoutRateLimitKey } from "@/lib/orders/rate-limit";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { PaymentProviderError } from "@/lib/payments/provider";
import { cardCheckoutRequestSchema } from "@/lib/payments/schemas";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { tryGetServerSupabaseEnvironment } from "@/lib/supabase/env";

/**
 * Online card checkout. One request does the whole thing so a closed browser cannot
 * strand a customer between an order and a charge:
 *
 *   1. the order is written as payment_pending — no kitchen ticket, no print job,
 *   2. a pending payment row is opened against a caller-supplied idempotency key,
 *   3. the card is charged,
 *   4. the outcome is settled: captured releases the order to the kitchen and marks
 *      it paid; failed cancels the order and releases any promotion use.
 *
 * If the provider cannot be reached the ledger stays pending on purpose. The webhook
 * and the reconciliation screen decide the truth rather than this request guessing.
 */
export async function POST(request: Request) {
  let input: unknown;
  try { input = await request.json(); } catch { return Response.json({ error: "Invalid order request." }, { status: 400 }); }
  const parsed = cardCheckoutRequestSchema.safeParse(input);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the order details." }, { status: 400 });

  if (!tryGetServerSupabaseEnvironment())
    return Response.json({ error: "Online ordering is temporarily unavailable. Please call Wayne's Pizza." }, { status: 503, headers: { "Cache-Control": "no-store" } });

  const resolved = await resolvePaymentProvider("online");
  if (!resolved.ok) return Response.json({ error: "Card payment is not available right now. Please call Wayne's Pizza." }, { status: 503, headers: { "Cache-Control": "no-store" } });

  const supabase = createServiceSupabaseClient();
  const { data: allowed, error: rateLimitError } = await supabase.rpc("wayne_consume_public_order_rate_limit", {
    client_key: checkoutRateLimitKey(request.headers),
  });
  if (rateLimitError) logger.error("card_checkout.rate_limit_unavailable", new Error(rateLimitError.message), { code: rateLimitError.code });
  if (rateLimitError || allowed !== true)
    return Response.json({ error: "Too many order attempts. Please wait a few minutes and try again." }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "300" } });

  // 1. The order exists but stays out of the kitchen until the card clears.
  const { data: orderData, error: orderError } = await supabase.rpc("wayne_create_card_order", { payload: parsed.data.order });
  if (orderError || !orderData) {
    logger.warn("card_checkout.order_failed", { code: orderError?.code });
    return Response.json({ error: customerSafeOrderError(orderError?.message ?? "") }, { status: 400 });
  }
  const order = orderData as { id: string; public_access_token: string; order_number: string; total_cents: number; duplicate: boolean };

  // 2. One payment per idempotency key, whatever the network does to this request.
  const { data: beginData, error: beginError } = await supabase.rpc("wayne_begin_payment", {
    payload: { order_id: order.id, idempotency_key: parsed.data.payment.idempotency_key, entry: "online", method: "card" },
  });
  if (beginError || !beginData) {
    logger.warn("card_checkout.begin_failed", { order_id: order.id, code: beginError?.code });
    return Response.json({ error: "That payment is already being processed. Check your order before trying again." }, { status: 409 });
  }
  const begun = beginData as { payment_id: string; status: string; duplicate: boolean };
  if (begun.duplicate)
    return Response.json({ ...publicOrder(order), payment_status: begun.status === "captured" ? "captured" : "pending" }, { headers: { "Cache-Control": "no-store" } });

  // 3. Charge.
  try {
    const result = await resolved.value.provider.createOnlinePayment({
      amountCents: order.total_cents,
      idempotencyKey: parsed.data.payment.idempotency_key,
      sourceId: parsed.data.payment.source_id,
      verificationToken: parsed.data.payment.verification_token ?? null,
      referenceId: order.order_number,
      note: `Wayne's Pizza order ${order.order_number}`,
    });

    // 4. Settle. Only a captured payment may release the order.
    await supabase.rpc("wayne_settle_payment", {
      payload: {
        payment_id: begun.payment_id,
        status: result.status === "authorized" ? "authorized" : result.status === "captured" ? "captured" : "failed",
        provider_payment_id: result.providerPaymentId,
        provider_status: result.providerStatus,
        amount_cents: result.amountCents,
        card_brand: result.cardBrand,
        card_last4: result.cardLast4,
        receipt_url: result.receiptUrl,
        failure_reason: result.failureReason,
      },
    });

    if (result.status !== "captured") {
      return Response.json({ error: result.failureReason ? "The card was declined. Try another card." : "The payment did not complete. No money was taken." }, { status: 402, headers: { "Cache-Control": "no-store" } });
    }
    return Response.json({ ...publicOrder(order), payment_status: "captured" }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    const providerError = cause instanceof PaymentProviderError ? cause : null;
    logger.error("card_checkout.provider_failed", cause, { order_id: order.id, code: providerError?.code });

    // A declined card is a definite answer: settle it and free the order.
    if (providerError && !providerError.retryable) {
      await supabase.rpc("wayne_settle_payment", {
        payload: { payment_id: begun.payment_id, status: "failed", provider_status: providerError.code, failure_reason: providerError.message },
      });
      return Response.json({ error: providerError.message }, { status: 402, headers: { "Cache-Control": "no-store" } });
    }
    // No answer at all: leave the ledger pending so the webhook decides.
    return Response.json({
      error: "We could not reach the card network. Do not re-enter your card — call Wayne's Pizza to confirm before paying again.",
      order_number: order.order_number,
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}

function publicOrder(order: { id: string; public_access_token: string; order_number: string; total_cents: number }) {
  return { id: order.id, public_access_token: order.public_access_token, order_number: order.order_number, total_cents: order.total_cents };
}

function customerSafeOrderError(message: string) {
  const expected = [
    "currently closed", "currently unavailable", "unavailable right now", "Choose", "required", "valid",
    "minimum", "modifier", "variant", "Cart", "quantity", "Promotion", "Tip", "Test ordering", "switched on",
  ];
  return expected.some((part) => message.includes(part)) ? message : "The order could not be placed. Please review it and try again.";
}
