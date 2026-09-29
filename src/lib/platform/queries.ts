import "server-only";

import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { logger } from "@/lib/logging/logger";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  mySupportSessionSchema,
  platformAuditEntrySchema,
  platformDashboardSchema,
  platformMeSchema,
  workspaceAuditSchema,
  workspaceDetailSchema,
  workspaceMembersSchema,
  workspaceSummarySchema,
  type MySupportSession,
  type PlatformMe,
} from "./schemas";
import { platformIntegrationsSchema } from "./integrations";
import { platformMessagingSchema } from "./messaging";
import { platformHardwareSchema } from "./hardware";

/** The signed-in Hanafy platform user, or null for everyone else. */
export const getPlatformMe = cache(async (): Promise<PlatformMe | null> => {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_platform_me");
  if (error || data === null) return null;
  const parsed = platformMeSchema.safeParse(data);
  if (!parsed.success) {
    logger.warn("platform.me_unparseable", { issue: parsed.error.issues[0]?.message ?? null });
    return null;
  }
  return parsed.data;
});

/**
 * Guard for every /platform page and action.  Anyone who is not active
 * platform staff gets a plain 404, so the console does not advertise itself
 * to business owners.  The database checks the role again on every call.
 */
export async function requirePlatformUser(options: { manage?: boolean; support?: boolean; nextPath?: string } = {}): Promise<PlatformMe> {
  const supabase = await createServerSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) redirect(`/login?next=${encodeURIComponent(options.nextPath ?? "/platform")}`);
  const me = await getPlatformMe();
  if (!me) notFound();
  if (options.manage && !me.can_manage) redirect("/platform?error=" + encodeURIComponent("Your platform role can view but not change businesses."));
  if (options.support && !me.can_support) redirect("/platform?error=" + encodeURIComponent("Your platform role cannot open support sessions."));
  return me;
}

/** The caller's live support session (any business), for banners. */
export const getMySupportSession = cache(async (): Promise<MySupportSession | null> => {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_my_support_session");
  if (error || data === null) return null;
  const parsed = mySupportSessionSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
});

async function call<T>(name: string, args: Record<string, unknown> | undefined, parse: (value: unknown) => T): Promise<T> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    if (error.code === "P0002") notFound();
    logger.error("platform.read_failed", error, { rpc: name, code: error.code ?? null });
    throw new Error(`Platform data could not be loaded (${name}).`);
  }
  return parse(data);
}

export function getPlatformDashboard() {
  return call("hanafy_platform_dashboard", undefined, (data) => platformDashboardSchema.parse(data));
}

export function getPlatformWorkspaces() {
  return call("hanafy_platform_workspaces", undefined, (data) => workspaceSummarySchema.array().parse(data));
}

export const getPlatformWorkspace = cache((slug: string) =>
  call("hanafy_platform_workspace_detail", { target_workspace_slug: slug }, (data) => workspaceDetailSchema.parse(data)),
);

export function getPlatformWorkspaceMembers(slug: string) {
  return call("hanafy_platform_workspace_members", { target_workspace_slug: slug }, (data) => workspaceMembersSchema.parse(data));
}

export function getPlatformWorkspaceAudit(slug: string, maxRows = 150) {
  return call("hanafy_platform_workspace_audit", { target_workspace_slug: slug, max_rows: maxRows }, (data) => workspaceAuditSchema.parse(data));
}

export function getPlatformAudit(maxRows = 300) {
  return call("hanafy_platform_audit", { max_rows: maxRows }, (data) => platformAuditEntrySchema.array().parse(data));
}

export function getPlatformWorkspaceMessaging(slug: string) {
  return call("hanafy_platform_workspace_messaging", { target_workspace_slug: slug }, (data) => platformMessagingSchema.parse(data));
}

export function getPlatformWorkspaceIntegrations(slug: string) {
  return call("hanafy_platform_workspace_integrations", { target_workspace_slug: slug }, (data) => platformIntegrationsSchema.parse(data));
}

export function getPlatformWorkspaceHardware(slug: string) {
  return call("hanafy_platform_workspace_hardware", { target_workspace_slug: slug }, (data) => platformHardwareSchema.parse(data));
}
