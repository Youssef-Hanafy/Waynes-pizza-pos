import { describe, expect, it } from "vitest";
import { parseTipInput, tipRoom } from "./schemas";

describe("tips from the signed slips (owner, 2026-10-13)", () => {
  it("reads what's typed off the slip", () => {
    expect(parseTipInput("")).toBe(0);
    expect(parseTipInput("5")).toBe(500);
    expect(parseTipInput("$4.50")).toBe(450);
    expect(parseTipInput("4.5")).toBe(450);
    expect(parseTipInput("abc")).toBeNull();
    expect(parseTipInput("-2")).toBeNull();
  });

  it("knows how much tip fits on the card", () => {
    expect(tipRoom({ authorized_cents: 4000, max_capture_cents: 9000 })).toBe(5000);
    expect(tipRoom({ authorized_cents: 4000, max_capture_cents: 4000 })).toBe(0);
  });
});
