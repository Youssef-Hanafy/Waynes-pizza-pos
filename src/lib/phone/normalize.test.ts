import { describe, expect, it } from "vitest";
import { formatPhone, normalizePhone, samePhone } from "./normalize";

describe("phone normalization", () => {
  it("turns every way a number is written into one form (build sheet §14)", () => {
    for (const input of ["508-555-1234", "(508) 555-1234", "5085551234", "+1 508 555 1234", "1-508-555-1234"]) {
      expect(normalizePhone(input)).toBe("+15085551234");
    }
  });
  it("refuses what is not a US number instead of guessing", () => {
    expect(normalizePhone("555-1234")).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("PRIVATE")).toBeNull();
    expect(normalizePhone("2-508-555-1234")).toBeNull();
  });
  it("formats for the screen and treats differently-written numbers as the same caller", () => {
    expect(formatPhone("+15085551234")).toBe("(508) 555-1234");
    expect(formatPhone("PRIVATE")).toBe("PRIVATE");
    expect(formatPhone("")).toBe("Unknown number");
    expect(samePhone("508.555.1234", "+15085551234")).toBe(true);
    expect(samePhone("", "")).toBe(false);
  });
});
