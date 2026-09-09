import { describe, expect, it } from "vitest";
import { getCalendarCells, shiftMonth } from "./calendar";

describe("admin order calendar", () => {
  it("builds a complete six-week Sunday-first grid", () => {
    const cells = getCalendarCells("2026-03");
    expect(cells).toHaveLength(42);
    expect(cells[0]?.date).toBe("2026-03-01");
    expect(cells[41]?.date).toBe("2026-04-11");
    expect(cells.filter((cell) => cell.inMonth)).toHaveLength(31);
  });

  it("moves across year boundaries", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});
