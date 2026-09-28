import { describe, expect, it } from "vitest";
import { buildWorkspaceNavigation } from "./navigation";

const allWaynes = ["pos", "online_ordering", "crm", "sms", "automations", "customer_segments", "caller_id", "analytics", "delivery", "staff_management", "website_storefront", "hardware_management"];
const ownerPermissions = ["admin.access", "audit.view", "cash.manage", "content.manage", "customers.view", "delivery.dispatch", "driver.access", "hardware.manage", "integrations.manage", "kitchen.access", "menu.manage", "orders.view", "payments.manage", "pos.access", "printing.manage", "promotions.manage", "reports.view", "segments.manage", "staff.view"];

const labels = (groups: ReturnType<typeof buildWorkspaceNavigation>) => groups.flatMap((group) => group.items.map((item) => item.label));

describe("workspace navigation", () => {
  it("shows every module an owner has in a fully enabled workspace", () => {
    const nav = buildWorkspaceNavigation({ permissions: ownerPermissions, enabledServices: allWaynes, legacyOperations: true });
    expect(labels(nav)).toEqual(expect.arrayContaining(["Register", "Kitchen", "Delivery", "Customer list", "Campaigns & automations", "Sales & reports", "Devices"]));
  });

  it("removes a module when its service is off even if the permission list were stale", () => {
    const nav = buildWorkspaceNavigation({ permissions: ownerPermissions, enabledServices: allWaynes.filter((code) => code !== "delivery" && code !== "sms" && code !== "automations"), legacyOperations: true });
    expect(labels(nav)).not.toContain("Delivery");
    expect(labels(nav)).not.toContain("Driver");
    expect(labels(nav)).not.toContain("Campaigns & automations");
    expect(labels(nav)).toContain("Register");
  });

  it("shows no operational screens for a workspace the pre-platform functions do not serve", () => {
    const nav = buildWorkspaceNavigation({ permissions: ownerPermissions, enabledServices: allWaynes, legacyOperations: false });
    expect(labels(nav)).toEqual(["Campaigns & automations"]);
  });

  it("follows permissions: a cashier sees only the register", () => {
    const nav = buildWorkspaceNavigation({ permissions: ["pos.access"], enabledServices: allWaynes, legacyOperations: true });
    expect(labels(nav)).toContain("Register");
    expect(labels(nav)).not.toContain("Sales & reports");
  });
});
