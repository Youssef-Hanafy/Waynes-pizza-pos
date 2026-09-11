"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/access";
import { assignDeliverySchema, deliveryErrorMessage, releaseDeliverySchema } from "@/lib/delivery/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const back = (message: string, key: "error" | "saved" = "error") => redirect(`/admin/delivery?${key}=${encodeURIComponent(message)}`);

export async function assignDelivery(form: FormData) {
  await requirePermission("delivery.dispatch", "/admin/delivery");
  const parsed = assignDeliverySchema.safeParse({ order_id: form.get("order_id"), driver_id: form.get("driver_id") });
  if (!parsed.success) back("Choose a driver for this delivery.");
  const supabase = await createServerSupabaseClient();
  // The database records the assignment, the order timeline entry, and the audit row.
  const { error } = await supabase.rpc("wayne_assign_delivery", {
    target_order_id: parsed.data!.order_id, target_driver_id: parsed.data!.driver_id,
  });
  if (error) back(deliveryErrorMessage(error));
  revalidatePath("/admin/delivery");
  back("Delivery assigned.", "saved");
}

export async function releaseDelivery(form: FormData) {
  await requirePermission("delivery.dispatch", "/admin/delivery");
  const parsed = releaseDeliverySchema.safeParse({ order_id: form.get("order_id"), reason: form.get("reason") });
  if (!parsed.success) back("Enter a reason of at least 3 characters before releasing a delivery.");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_release_delivery", {
    target_order_id: parsed.data!.order_id, reason: parsed.data!.reason,
  });
  if (error) back(deliveryErrorMessage(error));
  revalidatePath("/admin/delivery");
  back("Delivery released. Assign it to another driver when you are ready.", "saved");
}
