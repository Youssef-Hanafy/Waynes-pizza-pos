import { describe, expect, it } from "vitest";
import { pilotDecision, type PilotCheck } from "./schemas";

const check = (key: string, required: boolean, result: PilotCheck["result"]): PilotCheck =>
  ({ key, section: "Caller ID", label: key, detail: "", required, result, note: "", checked_by: null, checked_at: null });

describe("pilot go / no-go (build sheet Phase 9)", () => {
  it("is NO-GO until every required check has passed", () => {
    expect(pilotDecision([check("a", true, "pass"), check("b", true, null)]).go).toBe(false);
    expect(pilotDecision([check("a", true, "pass"), check("b", true, "pass"), check("c", false, null)])).toMatchObject({ go: true, passed: 2, required: 2 });
  });
  it("is NO-GO while anything has failed, even an optional check", () => {
    expect(pilotDecision([check("a", true, "pass"), check("c", false, "fail")]).go).toBe(false);
  });
  it("is never GO with nothing to check", () => {
    expect(pilotDecision([]).go).toBe(false);
  });
});
