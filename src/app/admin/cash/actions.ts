"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/access";
import { cashErrorMessage, parseCashCountInput } from "@/lib/cash/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const back = (message: string, key: "error" | "saved" = "error") => redirect(`/admin/cash?${key}=${encodeURIComponent(message)}`);

export async function saveRegister(form: FormData) {
  await requirePermission("cash.manage", "/admin/cash");
  const payload = {
    id: String(form.get("id") ?? ""),
    label: String(form.get("label") ?? "").trim(),
    location_note: String(form.get("location_note") ?? "").trim(),
    active: form.get("active") === "on",
  };
  if (!payload.label) back("Name the register.");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_save_register", { payload });
  if (error) {
    back(error.message.includes("registers_label_idx") || error.message.includes("duplicate key")
      ? "A register with that name already exists."
      : cashErrorMessage(error));
  }
  revalidatePath("/admin/cash");
  back("Register saved.", "saved");
}

/** A manager closing a drawer someone left open — same count and note rules apply. */
export async function closeDrawerAsManager(form: FormData) {
  await requirePermission("cash.manage", "/admin/cash");
  const counted = parseCashCountInput(String(form.get("counted") ?? ""));
  if (!counted.ok) back(counted.error);
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_close_shift", {
    payload: {
      shift_id: String(form.get("shift_id") ?? ""),
      counted_cash_cents: counted.ok ? counted.cents : 0,
      close_note: String(form.get("close_note") ?? "").trim(),
    },
  });
  if (error) back(cashErrorMessage(error));
  revalidatePath("/admin/cash");
  back("Drawer closed.", "saved");
}
