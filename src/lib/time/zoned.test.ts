import { describe, expect, it } from "vitest";
import { addDays, businessDate, utcToZonedLocal, zonedLocalToUtcIso } from "./zoned";

const tz = "America/New_York";

describe("store-timezone conversions", () => {
  it("converts Wayne's wall clock to UTC across daylight saving time", () => {
    expect(zonedLocalToUtcIso("2026-01-15T17:00", tz)).toBe("2026-01-15T22:00:00.000Z");
    expect(zonedLocalToUtcIso("2026-07-15T17:00", tz)).toBe("2026-07-15T21:00:00.000Z");
    expect(zonedLocalToUtcIso("not a date", tz)).toBeNull();
  });

  it("round-trips for datetime-local inputs and business dates", () => {
    expect(utcToZonedLocal("2026-07-15T21:00:00.000Z", tz)).toBe("2026-07-15T17:00");
    expect(utcToZonedLocal(null, tz)).toBe("");
    expect(businessDate(tz, new Date("2026-03-09T03:30:00Z"))).toBe("2026-03-08");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
