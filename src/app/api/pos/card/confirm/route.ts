import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { posCardConfirmRequestSchema } from "@/lib/payments/schemas";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

/** Re-reads Stripe's result server-side before releasing the ticket to the kitchen. */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = posCardConfirmRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid keyed card confirmation." }, { status: 400 });
  const resolved = await resolvePaymentProvider("online");
  if (!resolved.ok || resolved.value.provider.code !== "stripe") return Response.json({ error: "Stripe keyed card payment is not available." }, { status: 503 });
  const service = createServiceSupabaseClient();
  const { data: payment } = await service.from("payments")
    .select("id, provider_payment_id, order:orders!inner(id, order_number, total_cents, source, fulfillment_type)")
    .eq("id", parsed.data.payment_id).eq("provider", "stripe").maybeSingle();
  const order = payment?.order as unknown as { id: string; order_number: string; total_cents: number; source: string; fulfillment_type: string } | null;
  if (!payment?.provider_payment_id || !order || order.source !== "phone" || order.fulfillment_type !== "delivery") return Response.json({ error: "Keyed card payment not found." }, { status: 404 });
  try {
    const result = await resolved.value.provider.getPaymentStatus(payment.provider_payment_id);
    if (result.status !== "pending") {
      const { error: settleError } = await service.rpc("wayne_settle_payment", { payload: {
      payment_id: payment.id, status: result.status, provider_payment_id: result.providerPaymentId, provider_status: result.providerStatus,
      amount_cents: result.amountCents, card_brand: result.cardBrand, card_last4: result.cardLast4, receipt_url: result.receiptUrl,
      failure_reason: result.failureReason, metadata: { source: "pos_keyed_card_confirmation" },
      } });
      if (settleError) throw new Error("The payment was approved, but the ticket could not be finalized.");
    }
    return Response.json({ id: order.id, order_number: order.order_number, total_cents: order.total_cents, duplicate: false, payment_status: result.status === "captured" ? "captured" : result.status === "pending" ? "pending" : "failed" });
  } catch (cause) {
    logger.error("pos_keyed_card.stripe_confirm_failed", cause, { payment_id: payment.id });
    return Response.json({ error: cause instanceof Error ? cause.message : "We could not verify this payment. Do not enter the card again until the ticket is checked." }, { status: 502 });
  }
}
