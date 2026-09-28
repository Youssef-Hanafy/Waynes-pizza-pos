import { describe, expect, it } from "vitest";
import { hasEnabledWorkspaceService, hasWorkspacePermission } from "./permissions";
import type { WorkspaceContextRecord } from "./schemas";

const baseContext: WorkspaceContextRecord = {
  workspace_id: "70000000-0000-4000-8000-000000000001",
  workspace_slug: "waynes-pizza",
  workspace_name: "Wayne's Pizza",
  workspace_role: "cashier",
  has_platform_access: false,
  is_platform_admin: false,
  permissions: ["pos.access"],
  enabled_services: ["pos", "caller_id"]
};

describe("workspace entitlement helpers", () => {
  it("uses workspace permissions unless the user is an explicit platform administrator", () => {
    expect(hasWorkspacePermission(baseContext, "pos.access")).toBe(true);
    expect(hasWorkspacePermission(baseContext, "settings.manage")).toBe(false);
    expect(hasWorkspacePermission({ ...baseContext, is_platform_admin: true }, "settings.manage")).toBe(true);
  });

  it("does not infer an entitlement from platform access or permissions", () => {
    expect(hasEnabledWorkspaceService(baseContext, "pos")).toBe(true);
    expect(hasEnabledWorkspaceService({ ...baseContext, has_platform_access: true }, "sms")).toBe(false);
  });
});
