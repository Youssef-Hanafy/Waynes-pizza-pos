import { describe, expect, it } from "vitest";
import { checkoutRateLimitKey } from "./rate-limit";

describe("checkoutRateLimitKey", () => {
  it("uses the first forwarded address and never returns the raw address", () => {
    const key = checkoutRateLimitKey(
      new Headers({ "x-forwarded-for": "203.0.113.42, 10.0.0.1" }),
    );
    expect(key).toHaveLength(64);
    expect(key).not.toContain("203.0.113.42");
  });

  it("uses Vercel's trusted forwarding header when available", () => {
    expect(
      checkoutRateLimitKey(
        new Headers({
          "x-forwarded-for": "203.0.113.42",
          "x-vercel-forwarded-for": "198.51.100.24",
        }),
      ),
    ).toBe(checkoutRateLimitKey(new Headers({ "x-forwarded-for": "198.51.100.24" })));
  });
});
