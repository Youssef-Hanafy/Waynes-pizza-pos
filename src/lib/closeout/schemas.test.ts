import { describe, expect, it } from "vitest";
import { closeoutLayout, countedFromDenominations, dayCloseoutSchema } from "./schemas";
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
  it("makes manager, delivery and driver closeouts readable regardless of the saved small-font setting", () => {
    const layouts = [closeoutLayout(report, "Wayne's Pizza", 20000, true, "Manager with a long name"), deliveryCloseoutLayout(deliveries, "Wayne's Pizza"), driverTipsLayout({ storeName: "Wayne's Pizza", day: report.day, driverName: deliveries.drivers[0]!.name, cashout: null, today: deliveries.drivers[0]! })];
    for (const layout of layouts) {
      for (const line of layout.lines) {
        if (line.kind === "pair") expect(line.large, `${layout.title}: ${line.left}`).toBe(true);
        if (line.kind === "text") expect(line.large || line.tall, `${layout.title}: ${line.text}`).toBe(true);
      }
      expect(() => encodeEscPos(layout, { columns: 32, textSize: "xlarge", cut: "none" })).not.toThrow();
    }
    const manager = layouts[0]!;
    expect(manager.lines).toContainEqual(expect.objectContaining({ left: "Card tips to pay Manager with a long name" }));
    const encoded = String.fromCharCode(...encodeEscPos(manager, { columns: 48, textSize: "normal", cut: "none" }));
    expect(encoded).toContain("$12345.67");
    expect(encoded).toContain("(NO TIPS)");
  });
  it("adds up bills and coins", () => {
    expect(countedFromDenominations({ "20": 3, "1": 4, "0.25": 2 })).toBe(6450);
    expect(countedFromDenominations({ "100": 1, "0.01": 7, bogus: 5 })).toBe(10007);
    expect(countedFromDenominations({ "5": -2 })).toBe(0);
  });
});
