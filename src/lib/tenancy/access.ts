import "server-only";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { workspaceAccessSchema, type WorkspaceAccess } from "./schemas";

export async function isPlatformAdmin() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_is_platform_admin");
  return !error && data === true;
}

export async function requirePlatformAdmin(nextPath = "/platform") {
  const supabase = await createServerSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  if (!(await isPlatformAdmin())) redirect("/unauthorized");
}

export async function getWorkspaceAccess(workspaceId: string): Promise<WorkspaceAccess | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_my_workspace_access", { target_workspace_id: workspaceId });
  if (error || data === null) return null;
  const parsed = workspaceAccessSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}
