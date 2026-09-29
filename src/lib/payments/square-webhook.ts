import "server-only";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { readSquareWebhookObject, squareCheckoutStatus, squarePaymentStatus, squareRefundStatus } from "./square-mapping";

export type ServiceClient = ReturnType<typeof createServiceSupabaseClient>;

/** Applies one verified Square event to the payment ledger (shared by both webhook routes). */
export async function applySquareWebhookEvent(supabase: ServiceClient, eventType: string, payload: Record<string, unknown>) {
  const { payment, refund, checkout } = readSquareWebhookObject(payload);

  if (eventType.startsWith("payment.") && payment?.id) {
    const status = squarePaymentStatus(payment.status);
    if (status === "pending") return;
    const { error } = await supabase.rpc("wayne_settle_payment", {
      payload: {
        provider_payment_id: payment.id,
        status,
        provider_status: payment.status ?? "",
        amount_cents: payment.amount_money?.amount ?? null,
        card_brand: payment.card_details?.card?.card_brand ?? null,
        card_last4: payment.card_details?.card?.last_4 ?? null,
        receipt_url: payment.receipt_url ?? null,
        metadata: { source: "webhook" },
      },
    });
    // A payment we have never seen is not an error: it belongs to another system.
    if (error && error.code !== "P0002") throw new Error(error.message);
    return;
  }

  if (eventType.startsWith("terminal.checkout.") && checkout?.id) {
    const status = squareCheckoutStatus(checkout.status);
    if (status === "pending") return;
    const { error } = await supabase.rpc("wayne_settle_payment", {
      payload: {
        terminal_checkout_id: checkout.id,
        provider_payment_id: checkout.payment_ids?.[0] ?? null,
        status,
        provider_status: checkout.status ?? "",
        metadata: { source: "webhook" },
      },
    });
    if (error && error.code !== "P0002") throw new Error(error.message);
    return;
  }

  if (eventType.startsWith("refund.") && refund?.id) {
    const status = squareRefundStatus(refund.status);
    if (status === "pending") return;
    const { data: row } = await supabase.from("refunds").select("id").eq("provider_refund_id", refund.id).maybeSingle();
    if (!row) return;
    const { error } = await supabase.rpc("wayne_settle_refund", {
      payload: { refund_id: row.id, status, provider_refund_id: refund.id, provider_status: refund.status ?? "" },
    });
    if (error && error.code !== "P0002") throw new Error(error.message);
  }
}
