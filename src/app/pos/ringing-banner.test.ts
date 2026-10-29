import { describe, expect, it } from "vitest";
import type { PhoneCallView } from "@/lib/phone/phone-state";
import { bannerCalls } from "./ringing-banner";

const call = (patch: Partial<PhoneCallView>): PhoneCallView => ({
  key: "k1", serverId: "s1", line: 1, phoneNumber: "+15085551234", normalizedNumber: "+15085551234", callerName: "DAVID STRUB",
  occurredAt: "2026-10-29T15:00:00Z", surfacedAt: "2026-10-29T15:00:00Z", endedAt: null, status: "incoming", simulated: false, lookup: "done",
  matches: [], customerId: null, claimedById: null, claimedByName: null, claimedTerminal: "", orderId: null, orderNumber: null, unsynced: false, syncError: "",
  ...patch,
});
const me = { profileId: "p-ehab", terminal: "Register 1" };

describe("caller ID box (owner, 2026-10-29: always shows up)", () => {
  it("shows every ringing line", () => {
    expect(bannerCalls([call({}), call({ key: "k2", line: 2 })], me, new Set()).map((entry) => entry.key)).toEqual(["k1", "k2"]);
  });

  it("keeps a call this register opened until its order starts", () => {
    expect(bannerCalls([call({ status: "selected", claimedById: "p-ehab" })], me, new Set())).toHaveLength(1);
    expect(bannerCalls([call({ status: "selected", claimedTerminal: "Register 1" })], me, new Set())).toHaveLength(1);
    // Opened here before the server had it.
    expect(bannerCalls([call({ status: "selected", serverId: null })], me, new Set())).toHaveLength(1);
    expect(bannerCalls([call({ status: "order_started", claimedById: "p-ehab" })], me, new Set())).toHaveLength(0);
  });

  it("leaves a call another register picked up, and one this register hid", () => {
    expect(bannerCalls([call({ status: "selected", claimedById: "p-other", claimedTerminal: "Register 2" })], me, new Set())).toHaveLength(0);
    expect(bannerCalls([call({})], me, new Set(["k1"]))).toHaveLength(0);
    expect(bannerCalls([null], me, new Set())).toHaveLength(0);
  });
});
