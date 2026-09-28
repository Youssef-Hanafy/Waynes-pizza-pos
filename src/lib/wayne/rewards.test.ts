import { describe, expect, it } from "vitest";
import { rewardsConsentText } from "./rewards";

describe("Rewards consent wording", () => {
  it("keeps Wayne's recorded consent wording byte-for-byte", () => {
    expect(rewardsConsentText("Wayne’s Pizza")).toBe("I agree to receive recurring automated marketing texts from Wayne’s Pizza at this number. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.");
  });

  it("names whichever business the storefront belongs to", () => {
    expect(rewardsConsentText("Another Cafe")).toContain("marketing texts from Another Cafe at this number");
  });
});
