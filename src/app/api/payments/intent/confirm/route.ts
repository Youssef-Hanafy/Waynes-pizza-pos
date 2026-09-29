import { logger } from "@/lib/logging/logger";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { stripeConfirmRequestSchema } from "@/lib/payments/schemas";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

/** Re-reads the intent from Stripe; no browser-supplied payment outcome is trusted. */
export async function POST(request: Request) {
  const parsed = stripeConfirmRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid payment confirmation." }, { status: 400 });
  const resolved = await resolvePaymentProvider("online");
  if (!resolved.ok || resolved.value.provider.code !== "stripe") return Response.json({ error: "Online card payment is not available right now." }, { status: 503 });
  const supabase = createServiceSupabaseClient();
  const { data: payment } = await supabase.from("payments").select("id, provider, provider_payment_id, status, order:orders(id, public_access_token, order_number, total_cents)").eq("id", parsed.data.payment_id).eq("provider", "stripe").maybeSingle();
  if (!payment?.provider_payment_id || !payment.order) return Response.json({ error: "Payment not found." }, { status: 404 });
  try {
    const result = await resolved.value.provider.getPaymentStatus(payment.provider_payment_id);
    if (result.status !== "pending") {
      const { error } = await supabase.rpc("wayne_settle_payment", {
        payload: { payment_id: payment.id, provider_payment_id: result.providerPaymentId, status: result.status, provider_status: result.providerStatus, amount_cents: result.amountCents, card_brand: result.cardBrand, card_last4: result.cardLast4, receipt_url: result.receiptUrl, failure_reason: result.failureReason, metadata: { source: "stripe_confirmation" } },
      });
      if (error) throw new Error(error.message);
    }
    const order = payment.order as unknown as { id: string; public_access_token: string; order_number: string; total_cents: number };
    return Response.json({ ...order, payment_status: result.status === "captured" ? "captured" : result.status === "pending" ? "pending" : "failed" }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logger.error("stripe_intent.confirm_failed", cause, { payment_id: payment.id });
    return Response.json({ error: "We could not verify the payment. Do not pay again until you check your order." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
