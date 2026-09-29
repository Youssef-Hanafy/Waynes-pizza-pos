import { describe, expect, it } from "vitest";
import { formatMoney, parseDollarsToCents } from "./money";

describe("Hanafy billing money", () => {
  it("parses typed dollars into whole cents without floating point", () => {
    expect(parseDollarsToCents("249")).toBe(24900);
    expect(parseDollarsToCents("249.9")).toBe(24990);
    expect(parseDollarsToCents("$1,299.05")).toBe(129905);
    expect(parseDollarsToCents("0.29")).toBe(29);
    expect(parseDollarsToCents("-25.00")).toBe(-2500);
    expect(parseDollarsToCents("19.999")).toBeNull();
    expect(parseDollarsToCents("abc")).toBeNull();
    expect(parseDollarsToCents("")).toBeNull();
  });

  it("formats cents as dollars", () => {
    expect(formatMoney(129905)).toBe("$1,299.05");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(null)).toBe("$0.00");
  });
});
