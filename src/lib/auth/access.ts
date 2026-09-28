import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ACTIVE_WORKSPACE_COOKIE, parseWorkspaceSlug } from "@/lib/tenancy/active-workspace";
import { missingServiceForPath } from "@/lib/tenancy/services";
import { accessSchema, forLegacyOperations, hasPermission, type CurrentAccess, type Permission } from "./permissions";

export type { AppRole, CurrentAccess, Permission } from "./permissions";

type ServerClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

async function readAccess(supabase: ServerClient, slug: string | null): Promise<CurrentAccess | null> {
  const { data, error } = await supabase.rpc("hanafy_current_workspace_access", { target_workspace_slug: slug });
  if (error || data === null) return null;
  const parsed = accessSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * The signed-in user's access in the workspace they are working in.
 *
 * The workspace comes from the remembered slug (set by opening /w/[slug]),
 * re-validated by the database against the user's memberships on every
 * request; with no usable selection the user's only membership is used, and a
 * user with several memberships gets no access until they choose one.
 * Permissions are already reduced to the workspace's enabled services.
 */
export const getWorkspaceAccess = cache(async (): Promise<CurrentAccess | null> => {
  const supabase = await createServerSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return null;

  const cookieStore = await cookies();
  const selected = parseWorkspaceSlug(cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value);
  return (selected ? await readAccess(supabase, selected) : null) ?? (await readAccess(supabase, null));
});

/**
 * Access for the operational screens and API routes (/admin, /pos, /kitchen,
 * /driver).  They run on the pre-platform functions, so a workspace those
 * functions do not serve receives no operational permissions here.
 */
export async function getCurrentAccess(): Promise<CurrentAccess | null> {
  const access = await getWorkspaceAccess();
  return access ? forLegacyOperations(access) : null;
}

export async function isSignedIn() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.getUser();
  return !error && Boolean(data.user);
}

/** True for an active Hanafy platform user (decided by the database). */
export async function isPlatformUser() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_platform_role");
  return !error && typeof data === "string" && data.length > 0;
}

export async function requirePermission(permission: Permission, nextPath = "/admin") {
  const access = await getWorkspaceAccess();
  if (!access) {
    // Signed in but no workspace chosen (several memberships), or Hanafy
    // platform staff without a support session: they start in Platform Admin.
    if (await isSignedIn()) redirect((await isPlatformUser()) ? "/platform" : "/w");
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
  if (access.legacy_operations === false && access.workspace_slug) redirect(`/w/${access.workspace_slug}`);
  const missing = access.enabled_services ? missingServiceForPath(nextPath, access.enabled_services) : null;
  if (missing && access.workspace_slug) redirect(`/w/${access.workspace_slug}?unavailable=${missing}`);
  if (!hasPermission(access, permission)) redirect("/unauthorized");
  return access;
}
