import { describe, expect, it } from "vitest";
import { driverTipsLayout } from "./day-report";

describe("driver tips slip (owner, 2026-10-28: the ticket number, to match the paper slips)", () => {
  it("prints the day's slip number (#12), not the long order number", () => {
    const layout = driverTipsLayout({
      storeName: "Wayne's Pizza", day: "2026-10-27", driverName: "Ali", today: null, printedAt: new Date("2026-10-28T02:05:00Z"), timeZone: "America/New_York",
      cashout: {
        cashout_id: "11111111-1111-4111-8111-111111111111", driver_name: "Ali", order_count: 2, cash_orders_cents: 2747,
        cash_tips_cents: 0, card_tips_cents: 200, hand_in_cents: 2547,
        detail: [
          { order_id: "22222222-2222-4222-8222-222222222222", order_number: "W001173", daily_number: 12, paid_by: "card_held", total_cents: 3647, tip_cents: 200, cash_cents: 0 },
          { order_id: "33333333-3333-4333-8333-333333333333", order_number: "W000950", daily_number: null, paid_by: "cash", total_cents: 2747, tip_cents: 0, cash_cents: 2747 },
        ],
      },
    });
    const text = JSON.stringify(layout.lines);
    expect(text).toContain("#12 ");
    expect(text).not.toContain("#1173");
    // An old order with no day number still prints its short number.
    expect(text).toContain("#950 ");
  });
});
