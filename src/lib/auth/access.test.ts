import { describe, expect, it } from "vitest";
import { accessSchema, hasPermission, type CurrentAccess } from "./permissions";

const owner: CurrentAccess = {
  profile_id: "30000000-0000-4000-8000-000000000001",
  display_name: "Owner",
  role: "owner",
  permissions: ["admin.access", "staff.view", "staff.manage", "settings.manage", "pos.access", "kitchen.access", "driver.access"]
};

const cashier: CurrentAccess = {
  profile_id: "30000000-0000-4000-8000-000000000002",
  display_name: "Cashier",
  role: "cashier",
  permissions: ["pos.access"]
};

describe("hasPermission", () => {
  it("permits an owner for admin operations", () => {
    expect(hasPermission(owner, "admin.access")).toBe(true);
    expect(hasPermission(owner, "staff.manage")).toBe(true);
  });

  it("does not trust a role name without the required permission", () => {
    expect(hasPermission(cashier, "admin.access")).toBe(false);
    expect(hasPermission(cashier, "pos.access")).toBe(true);
  });

  it("rejects a missing profile", () => {
    expect(hasPermission(null, "admin.access")).toBe(false);
  });

  it("keeps staff signed in when the database adds a permission this build does not know", () => {
    const parsed = accessSchema.parse({ profile_id: owner.profile_id, display_name: "Owner", role: "owner", permissions: ["admin.access", "orders.cancel", "future.permission"] });
    expect(parsed.permissions).toEqual(["admin.access", "orders.cancel"]);
  });
});

describe("Hanafy support access", () => {
  it("parses a support-session access and keeps it separate from workspace roles", () => {
    const parsed = accessSchema.parse({
      profile_id: owner.profile_id,
      display_name: "Youssef (Hanafy support)",
      role: "hanafy_support",
      permissions: ["admin.access", "orders.view"],
      support_session: { id: "30000000-0000-4000-8000-000000000009", expires_at: "2026-10-01T15:00:00+00:00", platform_role: "platform_support", reason: "Missing order" },
    });
    expect(parsed.role).toBe("hanafy_support");
    expect(parsed.support_session?.platform_role).toBe("platform_support");
    expect(() => accessSchema.parse({ ...parsed, role: "platform_owner" })).toThrow();
  });
});

describe("workspace-aware access", () => {
  it("withholds legacy operations from a workspace the wayne_* functions do not serve", async () => {
    const { forLegacyOperations, hasService } = await import("./permissions");
    const other = { ...owner, legacy_operations: false, enabled_services: ["pos"] };
    expect(forLegacyOperations(other).permissions).toEqual([]);
    expect(forLegacyOperations({ ...owner, legacy_operations: true }).permissions).toEqual(owner.permissions);
    expect(forLegacyOperations(owner).permissions).toEqual(owner.permissions);
    expect(hasService(other, "pos")).toBe(true);
    expect(hasService(other, "sms")).toBe(false);
    expect(hasService(null, "pos")).toBe(false);
  });
});
