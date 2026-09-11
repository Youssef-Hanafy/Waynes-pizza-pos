import { describe, expect, it } from "vitest";
import { resolveDashboardRange } from "./range";

describe("dashboard time filters", () => {
  const thursday = "2026-09-10";
  it("resolves presets in business dates with Monday-start weeks", () => {
    expect(resolveDashboardRange(undefined, thursday)).toEqual({ preset: "today", from: thursday, to: thursday });
    expect(resolveDashboardRange("yesterday", thursday)).toMatchObject({ from: "2026-09-09", to: "2026-09-09" });
    expect(resolveDashboardRange("this_week", thursday)).toMatchObject({ from: "2026-09-07", to: thursday });
    expect(resolveDashboardRange("last_week", thursday)).toMatchObject({ from: "2026-08-31", to: "2026-09-06" });
    expect(resolveDashboardRange("month", thursday)).toMatchObject({ from: "2026-09-01", to: thursday });
    expect(resolveDashboardRange("this_week", "2026-09-07")).toMatchObject({ from: "2026-09-07", to: "2026-09-07" });
  });

  it("accepts a valid custom range and falls back to today otherwise", () => {
    expect(resolveDashboardRange("custom", thursday, "2026-08-01", "2026-08-31")).toEqual({ preset: "custom", from: "2026-08-01", to: "2026-08-31" });
    expect(resolveDashboardRange("custom", thursday, "2026-08-31", "2026-08-01").preset).toBe("today");
    expect(resolveDashboardRange("custom", thursday, "2024-01-01", "2026-08-01").preset).toBe("today");
  });
});
