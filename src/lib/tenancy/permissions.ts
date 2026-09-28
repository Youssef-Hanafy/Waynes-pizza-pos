import type { WorkspaceContextRecord } from "./schemas";

export function hasWorkspacePermission(context: WorkspaceContextRecord, permission: string) {
  return context.is_platform_admin || context.permissions.includes(permission);
}

export function hasEnabledWorkspaceService(context: WorkspaceContextRecord, serviceCode: string) {
  return context.enabled_services.includes(serviceCode);
}
