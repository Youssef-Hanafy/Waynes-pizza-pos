"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/*
 * Erasing a customer is the heavy one: their personal details are gone from
 * Wayne's for good and the CRM is told to delete their contact. Orders stay,
 * with the person scrubbed out of them, because those rows are the books.
 * Gated on settings.manage rather than customers.view - reading a profile and
 * erasing one are not the same authority.
 */
export async function eraseCustomerAction(customerId: string) {
  await requirePermission("settings.manage", "/admin/customers");
  const parsed = z.uuid().safeParse(customerId);
  if (!parsed.success) {
    redirect("/admin/customers?error=Invalid+customer");
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_erase_customer", {
    target_customer_id: parsed.data,
  });
  if (error) {
    redirect(`/admin/customers?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/admin/customers");
  revalidatePath(`/admin/customers/${parsed.data}`);
  redirect("/admin/customers?removed=1");
}
