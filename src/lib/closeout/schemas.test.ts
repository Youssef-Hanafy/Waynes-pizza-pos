import { describe, expect, it } from "vitest";
import { closeoutLayout, countedFromDenominations, dayCloseoutSchema, expectedCash, ownerTipsToPayOut } from "./schemas";
import { deliveryCloseoutLayout, deliveryDayReportSchema, driverTipsLayout } from "@/lib/delivery/day-report";
import { encodeEscPos } from "@/hardware/printers/escpos";

const report = dayCloseoutSchema.parse({
  day: "2026-10-20", timezone: "America/New_York", sales: { total_cents: 1234567, subtotal_cents: 1111111 },
  tenders: { cash_cents: 20000 }, online: {}, in_store: {}, refunds: {}, voids: {}, unpaid: {}, drawer: {}, saved: null,
});
const deliveries = deliveryDayReportSchema.parse({
  day: report.day, timezone: report.timezone,
  drivers: [{ driver_id: "47000000-0000-4000-8000-000000000001", name: "Driver with a long name", tips_cents: 12345, hand_in_cents: -2345, deliveries: 12 }],
});

describe("close out cash count (owner, 2026-10-13)", () => {
  it("matches manager, delivery and driver closeout text and figures to kitchen item size", () => {
    const layouts = [closeoutLayout(report, "Wayne's Pizza", 20000, true, "Manager with a long name"), deliveryCloseoutLayout(deliveries, "Wayne's Pizza"), driverTipsLayout({ storeName: "Wayne's Pizza", day: report.day, driverName: deliveries.drivers[0]!.name, cashout: null, today: deliveries.drivers[0]! })];
    for (const layout of layouts) {
      for (const line of layout.lines) {
        if (line.kind === "pair" || line.kind === "text") {
          expect(line.tall).toBe(true);
          expect(line.large).toBe(false);
        }
      }
      expect(() => encodeEscPos(layout, { columns: 32, textSize: "xlarge", cut: "none" })).not.toThrow();
    }
    const manager = layouts[0]!;
    expect(manager.lines).toContainEqual(expect.objectContaining({ left: "Card tips to pay Manager with a long name" }));
    const encoded = String.fromCharCode(...encodeEscPos(manager, { columns: 48, textSize: "normal", cut: "none" }));
    expect(encoded).toContain("$12345.67");
    expect(encoded).toContain("(NO TIPS)");
  });
  it("takes the owner's tips out of the expected drawer cash, once (owner, 2026-10-20)", () => {
    const shift = { id: "47000000-0000-4000-8000-000000000009", register_label: "Counter", opened_at: "2026-10-20T15:19:12Z", opening_cash_cents: 0, cash_sales_cents: 29704, cash_refunds_cents: 0, paid_in_cents: 0, paid_out_cents: 200, drop_cents: 0, driver_cash_cents: 0, expected_cash_cents: 29504 };
    const tonight = dayCloseoutSchema.parse({
      day: "2026-10-20", timezone: "America/New_York", sales: {}, tenders: { cash_cents: 29704 }, online: {}, in_store: {}, refunds: {}, voids: {}, unpaid: {},
      drawer: { open_shifts: [shift] }, saved: null,
      tip_payout: { owner_card_tips_cents: 767, owner_card_tip_count: 4, owner_cash_tips_cents: 0, driver_tips_cents: 200, income_cents: 0 },
    });
    // $295.04 in the drawer before tips; $7.67 of card tips paid to the owner → $287.37.
    expect(ownerTipsToPayOut(tonight)).toBe(767);
    expect(expectedCash(tonight)).toBe(28737);
    // Closing out again after the drawer closed: the tips already came out, nothing more.
    const again = dayCloseoutSchema.parse({ ...tonight, drawer: { closed_today: [{ ...shift, closed_at: null, counted_cash_cents: 28737, variance_cents: 0, expected_cash_cents: 28737 }] }, owner_tips_paid_out_cents: 767 });
    expect(expectedCash(again)).toBe(28737);
    // Cash tips the owner takes come out too.
    expect(expectedCash(dayCloseoutSchema.parse({ ...tonight, tip_payout: { ...tonight.tip_payout, owner_cash_tips_cents: 161 } }))).toBe(28576);
    // The slip shows the payout in the drawer section.
    const slip = closeoutLayout(tonight, "Wayne's Pizza", 28737, true, "Ehab");
    expect(slip.lines).toContainEqual(expect.objectContaining({ left: "Tips paid to Ehab", right: "-$7.67" }));
    expect(slip.lines).toContainEqual(expect.objectContaining({ left: "Expected", right: "$287.37" }));
    // A database from before tip_payout keeps the old math.
    expect(expectedCash({ ...tonight, tip_payout: null })).toBe(29504);
  });
  it("adds up bills and coins", () => {
    expect(countedFromDenominations({ "20": 3, "1": 4, "0.25": 2 })).toBe(6450);
    expect(countedFromDenominations({ "100": 1, "0.01": 7, bogus: 5 })).toBe(10007);
    expect(countedFromDenominations({ "5": -2 })).toBe(0);
  });
});
