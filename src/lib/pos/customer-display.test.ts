import { describe, expect, it } from "vitest";
import { displayStateSchema, signatureSvg, tipFromPercent } from "./customer-display";

describe("customer screen (owner, 2026-10-11)", () => {
  it("works out percentage tips in cents", () => {
    expect(tipFromPercent(3250, 20)).toBe(650);
    expect(tipFromPercent(1999, 15)).toBe(300);
  });

  it("fills in a blank state as the welcome screen", () => {
    expect(displayStateSchema.parse({}).phase).toBe("idle");
  });

  it("turns finger strokes into a standalone SVG", () => {
    const svg = signatureSvg([[[1, 2], [3, 4]]], 300, 120);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("M1.0 2.0L3.0 4.0");
  });
});
