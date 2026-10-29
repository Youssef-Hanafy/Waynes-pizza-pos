import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { logger } from "@/lib/logging/logger";
import { getWorkspaceAccess } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getPublicSupabaseEnvironment } from "@/lib/supabase/env";
import { defaultSettings, storeSettingsSchema, type StoreSettings } from "./schemas";

function createAnonymousClient() {
  const environment = getPublicSupabaseEnvironment();
  return createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

const publicWorkspaceSchema = z.object({
  workspace_id: z.uuid(),
  location_id: z.uuid(),
  workspace_slug: z.string().min(1),
  enabled_services: z.array(z.string()),
  legacy_operations: z.boolean(),
  brand_colors: z.object({ primary: z.string().regex(/^#[0-9a-f]{6}$/i).optional() }).catchall(z.unknown()).optional(),
});
export type PublicWorkspace = z.infer<typeof publicWorkspaceSchema>;

export type Storefront = {
  /** False for a host no workspace has claimed: nothing tenant-specific is shown. */
  known: boolean;
  workspace: PublicWorkspace | null;
  settings: StoreSettings;
  services: readonly string[];
};

export async function requestHost() {
  const requestHeaders = await headers();
  return requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "";
}

/** Host is the cache key, preventing storefront cross-tenant leakage. */
const getStorefrontForHost = cache(async (host: string): Promise<Storefront> => {
  const client = createAnonymousClient();
  const [workspaceResult, settingsResult] = await Promise.all([
    client.rpc("hanafy_public_workspace", { target_hostname: host }),
    client.rpc("hanafy_public_store_settings", { target_hostname: host }),
  ]);
  const workspaceParse = publicWorkspaceSchema.safeParse(workspaceResult.data);
  const settingsParse = storeSettingsSchema.safeParse(settingsResult.data);
  const workspace = workspaceResult.error || !workspaceParse.success ? null : workspaceParse.data;
  const settings = settingsResult.error || !settingsParse.success ? null : settingsParse.data;
  if (!workspace || !settings) {
    logger.warn("storefront.resolve_failed", { host, workspace_error: workspaceResult.error?.code ?? null, settings_error: settingsResult.error?.code ?? null,
      workspace_fields: workspaceParse.success ? [] : workspaceParse.error.issues.map((issue) => issue.path.join(".")),
      settings_fields: settingsParse.success ? [] : settingsParse.error.issues.map((issue) => issue.path.join(".")) });
    return { known: false, workspace: null, settings: defaultSettings, services: [] };
  }
  return { known: true, workspace, settings, services: workspace.enabled_services };
});

/** The storefront the request host belongs to (public pages, public APIs). */
export async function getStorefront() {
  return getStorefrontForHost(await requestHost());
}

export async function getStoreSettings() {
  return (await getStorefront()).settings;
}

/**
 * A public page that belongs to a storefront service: an unknown host or a
 * workspace without the service gets a 404 rather than another business's
 * content or a half-working page.
 */
export async function requireStorefront(service: string = "website_storefront") {
  const storefront = await getStorefront();
  if (!storefront.known || !storefront.services.includes("website_storefront") || !storefront.services.includes(service)) notFound();
  return storefront;
}

/**
 * Settings for staff screens: always the signed-in user's workspace, never
 * the request host (a register on any hostname shows its own business).
 */
export const getWorkspaceStoreSettings = cache(async (): Promise<StoreSettings> => {
  const access = await getWorkspaceAccess();
  if (!access?.workspace_id) return defaultSettings;
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_workspace_store_settings", { target_workspace_id: access.workspace_id });
  if (error || data === null) return defaultSettings;
  const parsed = storeSettingsSchema.safeParse(data);
  return parsed.success ? parsed.data : defaultSettings;
});

/** Settings for a public page, after its storefront service check (404 otherwise). */
export async function storefrontSettings(service: string = "website_storefront") {
  return (await requireStorefront(service)).settings;
}
