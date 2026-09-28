import "server-only";

import { getCurrentAccess } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { defaultHardwareSettings, hardwareSettingsSchema, type HardwareSettings } from "./schemas";

/**
 * Reads the store's hardware settings.  A POS must keep taking orders even if
 * this row cannot be read, so failure falls back to the simulator defaults and
 * says so rather than throwing.
 */
export async function getHardwareSettings(): Promise<{ settings: HardwareSettings; unavailable: boolean }> {
  const supabase = await createServerSupabaseClient();
  const access = await getCurrentAccess();
  if (!access?.workspace_id) return { settings: defaultHardwareSettings, unavailable: true };
  const { data, error } = await supabase
    .from("location_hardware_configurations")
    .select("configuration,updated_at")
    .eq("workspace_id", access.workspace_id)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  const parsed = hardwareSettingsSchema.safeParse(data && { ...data.configuration, updated_at: data.updated_at });
  if (error || !parsed.success) return { settings: defaultHardwareSettings, unavailable: true };
  return { settings: parsed.data, unavailable: false };
}
