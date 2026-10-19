"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const back = (message: string, key: "error" | "saved" = "saved"): never => redirect(`/admin/discounts?${key}=${encodeURIComponent(message)}`);

/** "5", "$5.00", "12.5%" → cents (fixed) or basis points (percent). */
function amountFrom(kind: "fixed" | "percent", raw: string) {
  const clean = raw.replace(/[$,%\s]/g, "");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(clean)) return null;
  const value = Math.round(Number(clean) * 100);
  if (value <= 0) return null;
  if (kind === "fixed" && value > 100_000) return null;
  if (kind === "percent" && value > 10_000) return null;
  return value;
}

/** Admin → Discounts: a discount every cashier can pick from the POS Discount button (owner, 2026-10-19). */
export async function savePosDiscount(form: FormData) {
  await requirePermission("pos.discount.manage", "/admin/discounts");
  const id = z.uuid().safeParse(form.get("id"));
  const kind = form.get("discount_type") === "percent" ? "percent" : "fixed";
  const name = String(form.get("name") ?? "").trim();
  if (!name) back("Give the discount a name (it shows on the button and the receipt).", "error");
  const amount = amountFrom(kind, String(form.get("amount") ?? ""));
  if (amount === null) back(kind === "fixed" ? "Type the dollars off, between $0.01 and $1,000." : "Type a percent between 0.01 and 100.", "error");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_save_pos_discount", {
    payload: {
      id: id.success ? id.data : "", name: name.slice(0, 60), discount_type: kind, discount_value: amount,
      active: form.get("active") === "on", sort_order: Number(form.get("sort_order") ?? 0) || 0,
    },
  });
  if (error) back(error.code === "22023" ? error.message : "The discount could not be saved.", "error");
  revalidatePath("/admin/discounts");
  revalidatePath("/pos");
  back(id.success ? `${name} updated.` : `${name} added — it is on the POS Discount button now.`);
}

export async function removePosDiscount(form: FormData) {
  await requirePermission("pos.discount.manage", "/admin/discounts");
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) back("That discount could not be found.", "error");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_archive_pos_discount", { target_id: id.data });
  if (error) back("The discount could not be removed.", "error");
  revalidatePath("/admin/discounts");
  back("Discount removed. Past orders keep it.");
}
