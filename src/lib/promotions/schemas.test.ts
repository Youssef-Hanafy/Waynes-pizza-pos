import { describe, expect, it } from "vitest";
import { describeDiscount, parsePromotionForm } from "./schemas";

const base = { code: "  pizza10 ", description: "Ten percent", discount_type: "percent", discount_amount: "10", minimum_order: "20", fulfillment_type: "", starts_at: "", ends_at: "", total_usage_limit: "", per_customer_limit: "1", active: "on" };

describe("promotion form", () => {
  it("stores percents as basis points and money as cents in the database's units", () => {
    const result = parsePromotionForm(base, "America/New_York");
    expect(result.ok && result.row).toMatchObject({ code: "PIZZA10", discount_value: 1000, minimum_order_cents: 2000, per_customer_limit: 1, total_usage_limit: null, active: true, fulfillment_type: null });
    const fixed = parsePromotionForm({ ...base, discount_type: "fixed", discount_amount: "5.5" }, "America/New_York");
    expect(fixed.ok && fixed.row.discount_value).toBe(550);
    expect(describeDiscount({ discount_type: "percent", discount_value: 1000 })).toBe("10% off");
  });

  it("interprets schedule times on Wayne's clock and rejects bad input", () => {
    const scheduled = parsePromotionForm({ ...base, starts_at: "2026-07-01T11:00", ends_at: "2026-07-31T23:00" }, "America/New_York");
    expect(scheduled.ok && scheduled.row.starts_at).toBe("2026-07-01T15:00:00.000Z");
    expect(parsePromotionForm({ ...base, discount_amount: "150" }, "America/New_York")).toEqual({ ok: false, error: "A percent discount cannot exceed 100%." });
    expect(parsePromotionForm({ ...base, code: "no spaces" }, "America/New_York").ok).toBe(false);
    expect(parsePromotionForm({ ...base, starts_at: "2026-07-31T23:00", ends_at: "2026-07-01T11:00" }, "America/New_York").ok).toBe(false);
  });
});
