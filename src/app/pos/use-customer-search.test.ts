import { describe, expect, it } from "vitest";
import { isSearchable } from "./use-customer-search";

describe("live customer search", () => {
  it("searches from three digits of a phone or two letters of a name", () => {
    expect(isSearchable("50")).toBe(false);
    expect(isSearchable("508")).toBe(true);
    expect(isSearchable("Jo")).toBe(true);
    expect(isSearchable(" J ")).toBe(false);
    expect(isSearchable("")).toBe(false);
  });
});
