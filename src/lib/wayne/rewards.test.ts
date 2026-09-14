import { describe, it, expect } from "vitest";
import { parseRewardsSignup, WAYNE_REWARDS_CONSENT_VERSION } from "./rewards";
const signup = { phone: "(508) 555-0198", consent: true, consentVersion: WAYNE_REWARDS_CONSENT_VERSION };
describe("Wayne’s Rewards signup", () => {
  it("normalizes valid US numbers", () => {
    expect(parseRewardsSignup(signup).phone).toBe("+15085550198");
    expect(parseRewardsSignup({ ...signup, phone: "+1 508 555 0198" }).phone).toBe("+15085550198");
  });
  it("rejects malformed numbers, implicit consent, and outdated terms", () => {
    for (const phone of ["123", "0000000000", "508abc5550198", "+44 20 7946 0123"]) expect(() => parseRewardsSignup({ ...signup, phone })).toThrow();
    for (const consent of [false, "true", 1, undefined]) expect(() => parseRewardsSignup({ ...signup, consent })).toThrow();
    expect(() => parseRewardsSignup({ ...signup, consentVersion: "old" })).toThrow();
  });
});
