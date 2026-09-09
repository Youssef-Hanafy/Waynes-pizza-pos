import { describe, expect, it } from "vitest";
import { isMenuItemAvailableNow } from "./availability";

const base = {
  available_days: [1],
  available_start: "11:00",
  available_end: "22:00",
};

describe("menu item availability", () => {
  it("uses the store timezone for same-day windows", () => {
    expect(
      isMenuItemAvailableNow(
        base,
        "America/New_York",
        new Date("2026-09-07T16:00:00Z"),
      ),
    ).toBe(true);
    expect(
      isMenuItemAvailableNow(
        base,
        "America/New_York",
        new Date("2026-09-07T14:59:00Z"),
      ),
    ).toBe(false);
  });
  it("supports overnight windows using the opening day", () => {
    const overnight = {
      available_days: [5],
      available_start: "20:00",
      available_end: "02:00",
    };
    expect(
      isMenuItemAvailableNow(
        overnight,
        "America/New_York",
        new Date("2026-09-12T05:00:00Z"),
      ),
    ).toBe(true);
    expect(
      isMenuItemAvailableNow(
        overnight,
        "America/New_York",
        new Date("2026-09-12T07:00:00Z"),
      ),
    ).toBe(false);
  });
  it("honors day-only availability", () => {
    expect(
      isMenuItemAvailableNow(
        { ...base, available_start: null, available_end: null },
        "America/New_York",
        new Date("2026-09-07T16:00:00Z"),
      ),
    ).toBe(true);
    expect(
      isMenuItemAvailableNow(
        { ...base, available_start: null, available_end: null },
        "America/New_York",
        new Date("2026-09-08T16:00:00Z"),
      ),
    ).toBe(false);
  });
});
