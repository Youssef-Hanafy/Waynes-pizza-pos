import "server-only";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { defaultHardwareSettings, hardwareSettingsSchema, type HardwareSettings } from "./schemas";

/**
 * Reads the store's hardware settings.  A POS must keep taking orders even if
 * this row cannot be read, so failure falls back to the simulator defaults and
 * says so rather than throwing.
 */
export async function getHardwareSettings(): Promise<{ settings: HardwareSettings; unavailable: boolean }> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_hardware_settings");
  const parsed = hardwareSettingsSchema.safeParse(data);
  if (error || !parsed.success) return { settings: defaultHardwareSettings, unavailable: true };
  return { settings: parsed.data, unavailable: false };
}
