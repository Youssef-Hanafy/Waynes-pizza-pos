import { describe, expect, it } from "vitest";
import { ticketLabel, ticketNumber } from "./ticket-number";

describe("daily ticket numbers (owner, 2026-10-13: every day start at 1, 2, 3)", () => {
  it("uses the day's number when there is one", () => {
    expect(ticketNumber({ order_number: "W001052", daily_number: 3 })).toBe("3");
    expect(ticketLabel({ order_number: "W001052", daily_number: 3 })).toBe("#3");
  });
  it("falls back to the W number without its zeros for older orders", () => {
    expect(ticketNumber({ order_number: "W001052", daily_number: null })).toBe("1052");
    expect(ticketNumber({ order_number: "W001052" })).toBe("1052");
  });
  it("marks an add-on with the number of the order it belongs to", () => {
    expect(ticketLabel({ order_number: "W001060", daily_number: 3, parent_order_id: "66000000-0000-4000-8000-000000000001" })).toBe("#3 add-on");
  });
});
