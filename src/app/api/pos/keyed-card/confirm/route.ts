import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { posKeyedCardConfirmSchema } from "@/lib/payments/schemas";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

/** Rechecks Stripe server-side and settles the delivery order's payment ledger. */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access") || !access?.workspace_id) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = posKeyedCardConfirmSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid keyed card confirmation." }, { status: 400 });
  const resolved = await resolvePaymentProvider("online", { workspaceId: access.workspace_id, locationId: access.location_id ?? null });
  if (!resolved.ok || resolved.value.provider.code !== "stripe") return Response.json({ error: "Stripe keyed card payment is not available." }, { status: 503 });

  const service = createServiceSupabaseClient();
  const { data: payment } = await service.from("payments")
    .select("id, provider_payment_id, amount_cents, metadata, order:orders!inner(id, workspace_id, source, fulfillment_type)")
    .eq("id", parsed.data.payment_id).eq("provider", "stripe").eq("orders.workspace_id", access.workspace_id).maybeSingle();
  const order = payment?.order as unknown as { id: string } | null;
  if (!payment?.provider_payment_id || !order) return Response.json({ error: "Keyed card payment not found." }, { status: 404 });

  try {
    const result = await resolved.value.provider.getPaymentStatus(payment.provider_payment_id);
    // A keyed card is authorised for the order; the tip from the slip is added when it is captured.
    // max_capture_cents is how far Stripe lets this card be captured (order + the most tip it can take).
    const held = result.status === "authorized";
    // Exactly the amount this payment was opened for (order + any phone tip, owner 2026-10-31). Stripe
    // approving anything else is never written to the books as if it matched.
    if ((result.status === "authorized" || result.status === "captured") && typeof result.amountCents === "number" && result.amountCents !== payment.amount_cents) {
      logger.error("pos.keyed_card_amount_mismatch", new Error("Stripe amount differs from the payment"), { payment_id: payment.id, expected: payment.amount_cents, stripe: result.amountCents });
      return Response.json({ error: `Stripe shows $${(result.amountCents / 100).toFixed(2)} on this card but the ticket expected $${(payment.amount_cents / 100).toFixed(2)}. Don't key the card again — check this payment in Stripe.`, code: "AMOUNT_MISMATCH" }, { status: 409 });
    }
    if (result.status !== "pending") {
      const { error } = await service.rpc("wayne_settle_payment", { payload: {
        payment_id: payment.id, status: result.status, provider_payment_id: result.providerPaymentId, provider_status: result.providerStatus,
        amount_cents: held ? payment.amount_cents : result.amountCents, card_brand: result.cardBrand, card_last4: result.cardLast4, receipt_url: result.receiptUrl,
        failure_reason: result.failureReason, metadata: { source: "pos_keyed_card", ...(held ? { tip_adjust: true, max_capture_cents: result.maxCapturableCents ?? payment.amount_cents } : {}) },
      } });
      if (error) throw new Error("The payment was approved, but the ticket could not be finalized.");
    }
    return Response.json({ payment_status: result.status === "captured" ? "captured" : held ? "authorized" : result.status === "pending" ? "pending" : "failed" }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logger.error("pos.keyed_card_confirm_failed", cause, { payment_id: payment.id });
    return Response.json({ error: cause instanceof Error ? cause.message : "We could not verify this payment. Do not enter the card again until the ticket is checked." }, { status: 502 });
  }
}
