import { describe, expect, it } from "vitest";
import { secureTokenEquals, signHanafyEnvelope } from "./hanafy";
describe("Hanafy event signing", () => {
  it("uses a timestamp-bound HMAC envelope signature", () => {
    expect(signHanafyEnvelope("01234567890123456789012345678901", "2026-09-10T20:00:00.000Z", '{"event_id":"abc"}')).toBe("sha256=f3b03dc6be5991b5f5b0a353470313fadeda5925a863bd80c784bb3b24a22ae0");
    expect(signHanafyEnvelope("01234567890123456789012345678901", "2026-09-10T20:00:01.000Z", '{"event_id":"abc"}')).not.toBe(signHanafyEnvelope("01234567890123456789012345678901", "2026-09-10T20:00:00.000Z", '{"event_id":"abc"}'));
  });
  it("does not accept a partial worker token", () => { expect(secureTokenEquals("token", "token")).toBe(true); expect(secureTokenEquals("token", "token-extra")).toBe(false); });
});
