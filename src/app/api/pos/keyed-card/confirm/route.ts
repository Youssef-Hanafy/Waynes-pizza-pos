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
    .select("id, provider_payment_id, order:orders!inner(id, workspace_id, source, fulfillment_type)")
    .eq("id", parsed.data.payment_id).eq("provider", "stripe").eq("orders.workspace_id", access.workspace_id).maybeSingle();
  const order = payment?.order as unknown as { id: string } | null;
  if (!payment?.provider_payment_id || !order) return Response.json({ error: "Keyed card payment not found." }, { status: 404 });

  try {
    const result = await resolved.value.provider.getPaymentStatus(payment.provider_payment_id);
    if (result.status !== "pending") {
      const { error } = await service.rpc("wayne_settle_payment", { payload: {
        payment_id: payment.id, status: result.status, provider_payment_id: result.providerPaymentId, provider_status: result.providerStatus,
        amount_cents: result.amountCents, card_brand: result.cardBrand, card_last4: result.cardLast4, receipt_url: result.receiptUrl,
        failure_reason: result.failureReason, metadata: { source: "pos_keyed_card" },
      } });
      if (error) throw new Error("The payment was approved, but the ticket could not be finalized.");
    }
    return Response.json({ payment_status: result.status === "captured" ? "captured" : result.status === "pending" ? "pending" : "failed" }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logger.error("pos.keyed_card_confirm_failed", cause, { payment_id: payment.id });
    return Response.json({ error: cause instanceof Error ? cause.message : "We could not verify this payment. Do not enter the card again until the ticket is checked." }, { status: 502 });
  }
}
