import "server-only";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasEnabledWorkspaceService, hasWorkspacePermission } from "./permissions";
import {
  locationRowSchema,
  locationSlugSchema,
  workspaceContextSchema,
  workspacePermissionSchema,
  workspaceRowSchema,
  workspaceServiceCodeSchema,
  workspaceSlugSchema,
  myWorkspacesSchema,
  type MyWorkspace,
  type WorkspaceContextRecord
} from "./schemas";

export class WorkspaceAccessError extends Error {
  constructor(
    public readonly code: "UNAUTHENTICATED" | "WORKSPACE_NOT_FOUND" | "WORKSPACE_FORBIDDEN" | "LOCATION_NOT_FOUND" | "PERMISSION_DENIED" | "SERVICE_DISABLED"
  ) {
    super(code);
    this.name = "WorkspaceAccessError";
  }
}

type RequireWorkspaceContextInput = {
  workspaceSlug: string;
  locationSlug?: string;
  requiredPermission?: string;
  requiredService?: string;
};

export type ResolvedWorkspaceContext = WorkspaceContextRecord & {
  location: ReturnType<typeof locationRowSchema.parse> | null;
  userId: string;
  workspace: ReturnType<typeof workspaceRowSchema.parse>;
};

/**
 * Resolves route-provided slugs into an RLS-protected, server-validated tenant
 * context. New Phase 2+ handlers should use this rather than accepting a raw
 * workspace id from the browser.
 */
export async function requireWorkspaceContext(input: RequireWorkspaceContextInput): Promise<ResolvedWorkspaceContext> {
  const workspaceSlug = workspaceSlugSchema.parse(input.workspaceSlug);
  const locationSlug = input.locationSlug === undefined ? undefined : locationSlugSchema.parse(input.locationSlug);
  const requiredPermission = input.requiredPermission === undefined ? undefined : workspacePermissionSchema.parse(input.requiredPermission);
  const requiredService = input.requiredService === undefined ? undefined : workspaceServiceCodeSchema.parse(input.requiredService);

  const supabase = await createServerSupabaseClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new WorkspaceAccessError("UNAUTHENTICATED");

  const { data: workspaceData, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id, slug, name, status, timezone, currency_code")
    .eq("slug", workspaceSlug)
    .maybeSingle();
  if (workspaceError || !workspaceData) throw new WorkspaceAccessError("WORKSPACE_NOT_FOUND");
  const workspace = workspaceRowSchema.parse(workspaceData);

  const { data: contextData, error: contextError } = await supabase.rpc("hanafy_workspace_context", {
    target_workspace_id: workspace.id
  });
  if (contextError || contextData === null) throw new WorkspaceAccessError("WORKSPACE_FORBIDDEN");
  const context = workspaceContextSchema.parse(contextData);

  if (requiredPermission && !hasWorkspacePermission(context, requiredPermission)) {
    throw new WorkspaceAccessError("PERMISSION_DENIED");
  }
  if (requiredService && !hasEnabledWorkspaceService(context, requiredService)) {
    throw new WorkspaceAccessError("SERVICE_DISABLED");
  }

  let location: ResolvedWorkspaceContext["location"] = null;
  if (locationSlug) {
    const { data: locationData, error: locationError } = await supabase
      .from("locations")
      .select("id, workspace_id, slug, name, status, timezone")
      .eq("workspace_id", workspace.id)
      .eq("slug", locationSlug)
      .maybeSingle();
    if (locationError || !locationData) throw new WorkspaceAccessError("LOCATION_NOT_FOUND");
    location = locationRowSchema.parse(locationData);
  }

  return { ...context, location, userId: userData.user.id, workspace };
}

/** Workspaces the signed-in user can open (memberships; all of them for platform staff). */
export async function listMyWorkspaces(): Promise<MyWorkspace[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_my_workspaces");
  if (error) return [];
  const parsed = myWorkspacesSchema.safeParse(data ?? []);
  return parsed.success ? parsed.data : [];
}
