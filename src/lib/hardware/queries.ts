import "server-only";

import { getCurrentAccess, type CurrentAccess } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { defaultHardwareSettings, hardwareSettingsSchema, type HardwareSettings } from "./schemas";
import { workspaceDevicesSchema, type HardwareDevice } from "@/lib/platform/hardware";

/**
 * Reads the store's hardware settings.  A POS must keep taking orders even if
 * this row cannot be read, so failure falls back to the simulator defaults and
 * says so rather than throwing.
 */
/**
 * `scope` comes from a page's permission check when available. Reusing that
 * verified workspace/location prevents a second access lookup from falling
 * back to the safe defaults after a settings save.
 */
export async function getHardwareSettings(scope?: Pick<CurrentAccess, "workspace_id" | "location_id">): Promise<{ settings: HardwareSettings; unavailable: boolean }> {
  const supabase = await createServerSupabaseClient();
  const access = scope ?? await getCurrentAccess();
  if (!access?.workspace_id) return { settings: defaultHardwareSettings, unavailable: true };
  let query = supabase
    .from("location_hardware_configurations")
    .select("configuration,updated_at")
    .eq("workspace_id", access.workspace_id);
  if (access.location_id) query = query.eq("location_id", access.location_id);
  const { data, error } = await query.order("created_at").limit(1).maybeSingle();
  const parsed = hardwareSettingsSchema.safeParse(data && { ...data.configuration, updated_at: data.updated_at });
  if (error || !parsed.success) return { settings: defaultHardwareSettings, unavailable: true };
  return { settings: parsed.data, unavailable: false };
}

/** The store's device registry (Phase 10), read-only.  Null when it can't be read. */
export async function getWorkspaceDevices(workspaceSlug: string | null): Promise<HardwareDevice[] | null> {
  if (!workspaceSlug) return null;
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_workspace_devices", { target_workspace_slug: workspaceSlug });
  if (error) return null;
  const parsed = workspaceDevicesSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
