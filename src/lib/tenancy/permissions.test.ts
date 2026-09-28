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
  it("uses only the permissions the database resolved, even for platform administrators", () => {
    expect(hasWorkspacePermission(baseContext, "pos.access")).toBe(true);
    expect(hasWorkspacePermission(baseContext, "settings.manage")).toBe(false);
    // No silent platform bypass (build sheet §8.4): access comes from a support session.
    expect(hasWorkspacePermission({ ...baseContext, is_platform_admin: true }, "settings.manage")).toBe(false);
  });

  it("does not infer an entitlement from platform access or permissions", () => {
    expect(hasEnabledWorkspaceService(baseContext, "pos")).toBe(true);
    expect(hasEnabledWorkspaceService({ ...baseContext, has_platform_access: true }, "sms")).toBe(false);
  });
});
