import "server-only";

import type { PosOrderInput } from "@/lib/pos/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type PosKeyedCardStart = {
  order: { id: string; order_number: string; total_cents: number; duplicate: boolean };
  payment: { id: string; status: string; duplicate: boolean };
};

/** Creates a held POS order and opens its one card-payment ledger entry. */
export async function startPosKeyedCard(order: PosOrderInput): Promise<PosKeyedCardStart> {
  const supabase = await createServerSupabaseClient();
  const { data: orderData, error: orderError } = await supabase.rpc("wayne_create_pos_card_order", { payload: order });
  if (orderError || !orderData) throw new Error(orderError?.message ?? "The delivery order could not be prepared.");
  const rawOrder = orderData as { id?: string; order_number?: string; total_cents?: number; duplicate?: boolean };
  if (!rawOrder.id || !rawOrder.order_number || typeof rawOrder.total_cents !== "number") throw new Error("The delivery order could not be confirmed.");

  const { data: paymentData, error: paymentError } = await supabase.rpc("wayne_begin_payment", {
    payload: {
      order_id: rawOrder.id,
      idempotency_key: order.idempotency_key,
      entry: "pos_keyed_card",
      method: "card",
    },
  });
  if (paymentError || !paymentData) throw new Error(paymentError?.message ?? "The card payment could not be opened.");
  const rawPayment = paymentData as { payment_id?: string; status?: string; duplicate?: boolean };
  if (!rawPayment.payment_id || !rawPayment.status) throw new Error("The card payment could not be confirmed.");
  return {
    order: { id: rawOrder.id, order_number: rawOrder.order_number, total_cents: rawOrder.total_cents, duplicate: Boolean(rawOrder.duplicate) },
    payment: { id: rawPayment.payment_id, status: rawPayment.status, duplicate: Boolean(rawPayment.duplicate) },
  };
}
