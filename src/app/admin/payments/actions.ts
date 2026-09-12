"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/access";
import { paymentErrorMessage } from "@/lib/payments/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const back = (message: string, key: "error" | "saved" = "error") => redirect(`/admin/payments?${key}=${encodeURIComponent(message)}`);

export async function savePaymentSettings(form: FormData) {
  await requirePermission("payments.manage", "/admin/payments");
  const payload = {
    provider: String(form.get("provider") ?? "none"),
    environment: String(form.get("environment") ?? "sandbox"),
    application_id: String(form.get("application_id") ?? "").trim(),
    location_id: String(form.get("location_id") ?? "").trim(),
    notification_url: String(form.get("notification_url") ?? "").trim(),
    online_card_enabled: form.get("online_card_enabled") === "on",
    terminal_card_enabled: form.get("terminal_card_enabled") === "on",
  };
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_save_payment_settings", { payload });
  if (error) {
    back(error.message.includes("payment_provider_settings_ready")
      ? "Enter the application ID and location ID before switching card payment on."
      : paymentErrorMessage(error));
  }
  revalidatePath("/admin/payments");
  revalidatePath("/checkout");
  back("Payment settings saved.", "saved");
}

export async function savePaymentTerminal(form: FormData) {
  await requirePermission("payments.manage", "/admin/payments");
  const payload = {
    id: String(form.get("id") ?? ""),
    label: String(form.get("label") ?? "").trim(),
    device_id: String(form.get("device_id") ?? "").trim(),
    status: String(form.get("status") ?? "active"),
    notes: String(form.get("notes") ?? "").trim(),
  };
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_save_payment_terminal", { payload });
  if (error) {
    back(error.message.includes("payment_terminals_device_idx") || error.message.includes("duplicate key")
      ? "That device ID is already registered on another reader."
      : paymentErrorMessage(error));
  }
  revalidatePath("/admin/payments");
  back("Card reader saved.", "saved");
}
