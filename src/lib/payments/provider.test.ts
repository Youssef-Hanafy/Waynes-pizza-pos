import { describe, expect, it } from "vitest";
import { TEST_MANUAL_PAYMENT } from "./provider";

describe("Phase 2 payment boundary", () => {
  it("is explicitly unpaid manual test mode", () => {
    expect(TEST_MANUAL_PAYMENT).toEqual({ provider: "manual", method: "test_manual", state: "unpaid" });
  });
});
