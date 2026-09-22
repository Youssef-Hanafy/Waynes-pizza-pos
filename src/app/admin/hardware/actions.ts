"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/access";
import { hardwareSettingsFormSchema } from "@/lib/hardware/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const back = (message: string, key: "error" | "saved" = "error") => redirect(`/admin/hardware?${key}=${encodeURIComponent(message)}`);

function text(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim();
}

function columns(form: FormData, name: string) {
  const value = text(form, name);
  return value ? Number(value) : null;
}

function port(form: FormData, name: string) {
  const value = text(form, name);
  return value ? Number(value) : null;
}

/** Save Admin → Hardware (§28). Validated here, then in the database, then audited. */
export async function saveHardwareSettings(form: FormData) {
  await requirePermission("hardware.manage", "/admin/hardware");
  const parsed = hardwareSettingsFormSchema.safeParse({
    caller_id_provider: text(form, "caller_id_provider"),
    caller_line_count: text(form, "caller_line_count"),
    caller_udp_port: text(form, "caller_udp_port"),
    caller_bind_address: text(form, "caller_bind_address"),
    caller_device_ip: text(form, "caller_device_ip"),
    caller_device_model: text(form, "caller_device_model"),
    call_expire_minutes: text(form, "call_expire_minutes"),
    simulator_enabled: form.get("simulator_enabled") === "on",
    receipt_printer: {
      name: text(form, "receipt_name"), model: text(form, "receipt_model"), model_key: text(form, "receipt_model_key") || "generic", ip: text(form, "receipt_ip"),
      port: port(form, "receipt_port"), protocol: text(form, "receipt_protocol"), enabled: form.get("receipt_enabled") === "on",
      paper_width_mm: Number(text(form, "receipt_paper") || 80), columns: columns(form, "receipt_columns"),
      online_order_slips: form.get("receipt_online_slips") === "on", tip_slip: text(form, "receipt_tip_slip") || "always",
      auto_delivery_receipts: form.get("receipt_delivery_receipts") === "on",
    },
    kitchen_printer: {
      name: text(form, "kitchen_name"), model: text(form, "kitchen_model"), model_key: text(form, "kitchen_model_key") || "generic", ip: text(form, "kitchen_ip"),
      port: port(form, "kitchen_port"), protocol: text(form, "kitchen_protocol"), enabled: form.get("kitchen_enabled") === "on",
      paper_width_mm: Number(text(form, "kitchen_paper") || 76), columns: columns(form, "kitchen_columns"), two_color: form.get("kitchen_two_color") === "on",
      routing_categories: form.getAll("kitchen_categories").map(String),
    },
    cash_drawer: { connection: text(form, "drawer_connection") || "none", model: text(form, "drawer_model") },
  });
  if (!parsed.success) back(parsed.error.issues[0]?.message ?? "Check the hardware settings.");
  const input = parsed.data!;

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_update_hardware_settings", {
    payload: {
      caller_id_provider: input.caller_id_provider,
      caller_line_count: input.caller_line_count,
      caller_udp_port: input.caller_udp_port,
      caller_bind_address: input.caller_bind_address,
      caller_device_ip: input.caller_device_ip,
      caller_device_model: input.caller_device_model,
      call_expire_minutes: input.call_expire_minutes,
      simulator_enabled: input.simulator_enabled,
      receipt_printer: input.receipt_printer,
      kitchen_printers: [input.kitchen_printer],
      cash_drawer: input.cash_drawer,
    },
  });
  if (error) back(error.code === "42501" ? "Only the owner can change hardware settings." : "The hardware settings could not be saved.");
  revalidatePath("/admin/hardware");
  revalidatePath("/pos");
  back("Hardware settings saved. Registers pick them up the next time the POS is opened.", "saved");
}
