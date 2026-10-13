import { describe, expect, it } from "vitest";
import { countedFromDenominations } from "./schemas";

describe("close out cash count (owner, 2026-10-13)", () => {
  it("adds up bills and coins", () => {
    expect(countedFromDenominations({ "20": 3, "1": 4, "0.25": 2 })).toBe(6450);
    expect(countedFromDenominations({ "100": 1, "0.01": 7, bogus: 5 })).toBe(10007);
    expect(countedFromDenominations({ "5": -2 })).toBe(0);
  });
});
