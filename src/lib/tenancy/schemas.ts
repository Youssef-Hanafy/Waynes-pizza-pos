import { z } from "zod";

export const workspaceSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const locationSlugSchema = workspaceSlugSchema;
export const workspacePermissionSchema = z.string().regex(/^[a-z][a-z_.]*$/);
export const workspaceServiceCodeSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);

export const workspaceRowSchema = z.object({
  id: z.uuid(),
  slug: workspaceSlugSchema,
  name: z.string().min(1),
  status: z.enum(["provisioning", "active", "suspended", "archived"]),
  timezone: z.string().min(1),
  currency_code: z.string().length(3)
});

export const locationRowSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  slug: locationSlugSchema,
  name: z.string().min(1),
  status: z.enum(["provisioning", "active", "suspended", "archived"]),
  timezone: z.string().min(1)
});

export const workspaceContextSchema = z.object({
  workspace_id: z.uuid(),
  workspace_slug: workspaceSlugSchema,
  workspace_name: z.string().min(1),
  workspace_role: z.string().nullable(),
  has_platform_access: z.boolean(),
  is_platform_admin: z.boolean(),
  permissions: z.array(z.string()),
  enabled_services: z.array(z.string()),
  // Phase 5: true only for the workspace the pre-platform wayne_* operations serve.
  legacy_operations: z.boolean().optional(),
  // Phase 6: the caller's live Hanafy support session when they are not a member.
  support_session: z.object({ id: z.uuid(), expires_at: z.string(), platform_role: z.string(), reason: z.string() }).nullable().optional()
});

export type WorkspaceContextRecord = z.infer<typeof workspaceContextSchema>;

export const myWorkspaceSchema = z.object({
  id: z.uuid(),
  slug: workspaceSlugSchema,
  name: z.string().min(1),
  status: z.enum(["provisioning", "active", "suspended", "archived"]),
  role: z.string().nullable(),
  is_member: z.boolean()
});
export const myWorkspacesSchema = z.array(myWorkspaceSchema);
export type MyWorkspace = z.infer<typeof myWorkspaceSchema>;
