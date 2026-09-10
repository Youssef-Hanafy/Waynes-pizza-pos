import { describe, expect, it } from "vitest";
import { defaultSettings } from "./schemas";
import { isStoreOpenNow } from "./store-status";

describe("store status", () => {
  it("uses Wayne's configured timezone and regular hours", () => {
    expect(
      isStoreOpenNow(defaultSettings, new Date("2026-09-08T16:00:00Z")),
    ).toBe(true);
    expect(
      isStoreOpenNow(defaultSettings, new Date("2026-09-08T14:00:00Z")),
    ).toBe(false);
  });
  it("honors special closures", () => {
    expect(
      isStoreOpenNow(
        {
          ...defaultSettings,
          special_hours: [
            {
              id: crypto.randomUUID(),
              service_date: "2026-09-08",
              label: "Holiday",
              closed: true,
              opens_at: null,
              closes_at: null,
              public_note: "",
            },
          ],
        },
        new Date("2026-09-08T16:00:00Z"),
      ),
    ).toBe(false);
  });
  it("carries an overnight special-hours override into the next calendar day", () => {
    const settings = {
      ...defaultSettings,
      special_hours: [
        {
          id: crypto.randomUUID(),
          service_date: "2026-09-11",
          label: "Late Friday",
          closed: false,
          opens_at: "20:00:00",
          closes_at: "02:00:00",
          public_note: "",
        },
      ],
    };
    expect(
      isStoreOpenNow(settings, new Date("2026-09-12T05:00:00Z")),
    ).toBe(true);
    expect(
      isStoreOpenNow(settings, new Date("2026-09-12T06:00:00Z")),
    ).toBe(false);
  });
  it("honors the manual ordering toggle", () => {
    expect(
      isStoreOpenNow(
        { ...defaultSettings, ordering_open: false },
        new Date("2026-09-08T16:00:00Z"),
      ),
    ).toBe(false);
  });
});
