import "server-only";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { accessSchema, hasPermission, type CurrentAccess, type Permission } from "./permissions";

export type { AppRole, CurrentAccess, Permission } from "./permissions";

export async function getCurrentAccess(): Promise<CurrentAccess | null> {
  const supabase = await createServerSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();

  if (userError || !userData.user) return null;

  // This RPC derives an active workspace from the authenticated identity. It
  // deliberately returns no access for a user with ambiguous memberships;
  // workspace-routed UI will choose context explicitly in a later phase.
  const { data, error } = await supabase.rpc("hanafy_current_workspace_access");
  if (error || data === null) return null;

  const parsed = accessSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export async function requirePermission(permission: Permission, nextPath = "/admin") {
  const access = await getCurrentAccess();
  if (!access) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  if (!hasPermission(access, permission)) redirect("/unauthorized");
  return access;
}
