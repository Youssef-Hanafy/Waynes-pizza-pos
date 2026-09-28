import type { WorkspaceContextRecord } from "./schemas";

/**
 * Phase 6: platform roles grant nothing inside a business by themselves.  The
 * database already puts a live support session's permissions into the list.
 */
export function hasWorkspacePermission(context: WorkspaceContextRecord, permission: string) {
  return context.permissions.includes(permission);
}

export function hasEnabledWorkspaceService(context: WorkspaceContextRecord, serviceCode: string) {
  return context.enabled_services.includes(serviceCode);
}
