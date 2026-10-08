import "server-only";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/access";
import { hardwareSettingsFormSchema } from "@/lib/hardware/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

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

export type HardwareSaveResult = { key: "error" | "saved"; message: string };

/**
 * The single persistence path for Admin -> Hardware.
 *
 * It is deliberately shared by the legacy Server Action and the ordinary POST
 * route. The Android WebView can retain an old rendered page across a deploy;
 * a normal URL keeps that page's Save button valid instead of tying it to a
 * build-specific Server Action identifier.
 */
export async function persistHardwareSettings(form: FormData): Promise<HardwareSaveResult> {
  const access = await requirePermission("hardware.manage", "/admin/hardware");
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
    payment_terminal_mode: text(form, "payment_terminal_mode") || "manual_external",
  });
  if (!parsed.success) return { key: "error", message: parsed.error.issues[0]?.message ?? "Check the hardware settings." };
  const input = parsed.data;

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("hanafy_save_location_hardware_configuration", {
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
      payment_terminal_mode: input.payment_terminal_mode,
    },
    target_workspace_slug: access.workspace_slug ?? null,
  });
  if (error) return { key: "error", message: error.code === "42501" ? "Only the owner can change hardware settings." : "The hardware settings could not be saved." };

  revalidatePath("/admin/hardware");
  revalidatePath("/pos");
  return { key: "saved", message: "Hardware settings saved. Registers pick them up the next time the POS is opened." };
}
