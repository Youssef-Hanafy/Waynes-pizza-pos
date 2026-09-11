import { describe, expect, it } from "vitest";
import { goLiveChecklist, type SetupStatus } from "./schemas";

const empty: SetupStatus = { category_count: 0, menu_item_count: 0, visible_menu_item_count: 0, tax_rate_basis_points: 0, pickup_enabled: true, delivery_enabled: true, delivery_postal_code_count: 0, delivery_fee_cents: 0, delivery_minimum_cents: 0, ordering_open: true, test_ordering_enabled: true, public_phone_set: true, hanafy_configured: true, hanafy_active: true, hanafy_failed_count: 0, hanafy_queued_count: 0, active_staff_count: 1, pending_staff_count: 0, open_order_count: 0, stale_open_order_count: 0, failed_print_job_count: 0, active_promotion_count: 0 };

describe("go-live checklist", () => {
  it("flags the audit H3 gaps on an unconfigured store", () => {
    const open = goLiveChecklist(empty).filter((item) => !item.done).map((item) => item.label);
    expect(open).toEqual(["Add the menu", "Set the sales/meals tax rate", "Limit delivery to your area", "Confirm delivery fee and minimum", "Give each staff member a sign-in"]);
  });

  it("clears once the owner has configured the store", () => {
    const ready = goLiveChecklist({ ...empty, menu_item_count: 40, visible_menu_item_count: 38, tax_rate_basis_points: 700, delivery_postal_code_count: 5, delivery_fee_cents: 300, active_staff_count: 4 });
    expect(ready.every((item) => item.done)).toBe(true);
  });
});
