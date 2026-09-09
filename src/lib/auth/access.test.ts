import { describe, expect, it } from "vitest";
import { hasPermission, type CurrentAccess } from "./permissions";

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
});
