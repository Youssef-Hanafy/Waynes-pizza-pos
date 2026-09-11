"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/access";
import { orderTransitionSchema, transitionErrorMessage } from "@/lib/orders/status";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Admin order-detail status changes (hand-off, completion, cancellation). */
export async function changeOrderStatus(form: FormData) {
  const orderId = z.uuid().safeParse(form.get("order_id"));
  if (!orderId.success) redirect("/admin/orders");
  const path = `/admin/orders/${orderId.data}`;
  const nextStatus = String(form.get("next_status") ?? "");
  await requirePermission(nextStatus === "cancelled" ? "orders.cancel" : "orders.manage", path);
  if (nextStatus === "cancelled" && form.get("confirm") !== "on") redirect(`${path}?error=${encodeURIComponent("Tick the confirmation box to cancel this order.")}`);
  const parsed = orderTransitionSchema.safeParse({
    order_id: orderId.data,
    expected_status: form.get("expected_status"),
    next_status: nextStatus,
    reason: form.get("reason") ?? undefined,
  });
  if (!parsed.success) redirect(`${path}?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid order action.")}`);
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_transition_order", {
    target_order_id: parsed.data.order_id,
    expected_status: parsed.data.expected_status,
    next_status: parsed.data.next_status,
    reason: parsed.data.reason ?? null,
  });
  if (error) redirect(`${path}?error=${encodeURIComponent(transitionErrorMessage(error))}`);
  revalidatePath(path);
  revalidatePath("/admin/orders");
  revalidatePath("/admin");
  redirect(`${path}?saved=${parsed.data.next_status}`);
}
