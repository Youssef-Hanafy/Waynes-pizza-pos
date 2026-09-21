import { describe, expect, it } from "vitest";
import type { IncomingCallEvent } from "@/hardware/types";
import type { PosCustomer } from "@/lib/pos/schemas";
import {
  applyBoard, applyServerCall, callOnLine, expiredKeys, hasUnclaimedCall, initialPhoneState, matchOutcome, receiveIncoming, setStatus, waitingCallCount,
} from "./phone-state";
import type { PhoneBoard, PhoneCall } from "./schemas";

const t0 = Date.parse("2026-09-20T22:42:13.000Z");
const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();
const ring = (id: string, line: 1 | 2, phoneNumber: string, seconds = 0, source: IncomingCallEvent["source"] = "simulated"): IncomingCallEvent =>
  ({ id, line, phoneNumber, callerName: "TEST", occurredAt: at(seconds), source });

const rita: PosCustomer = {
  id: "63000000-0000-4000-8000-000000000001", first_name: "Rita", last_name: "Regular", phone: "+15085551234", email: null,
  first_order_at: null, last_order_at: null, order_count: 24, lifetime_spend_cents: 71616, average_order_value_cents: 2984, notes: "", phones: [], addresses: [],
};

function serverCall(overrides: Partial<PhoneCall> = {}): PhoneCall {
  return {
    id: "63000000-0000-4000-8000-0000000000aa", event_key: "a", line_number: 1, device_id: "", caller_number: "+15085551234", caller_number_raw: "5085551234",
    caller_name: "RITA", started_at: at(0), surfaced_at: at(0), ended_at: null, status: "incoming", simulated: true, customer_id: rita.id,
    claimed_by_id: null, claimed_by_name: null, claimed_terminal: "", claimed_at: null, order_id: null, order_number: null, matches: [rita],
    ...overrides,
  };
}

describe("phone state (build sheet §16, §17, §34)", () => {
  it("shows a Line 1 ring at once, before any lookup (§55)", () => {
    const { state, call } = receiveIncoming(initialPhoneState(), ring("a", 1, "(508) 555-1234"));
    expect(callOnLine(state, 1)?.key).toBe("a");
    expect(call.normalizedNumber).toBe("+15085551234");
    expect(matchOutcome(call)).toBe("looking_up");
    expect(waitingCallCount(state)).toBe(1);
    expect(hasUnclaimedCall(state)).toBe(true);
  });

  it("keeps two simultaneous calls on their own lines (tests 2, 3)", () => {
    let state = receiveIncoming(initialPhoneState(), ring("a", 1, "5085551234")).state;
    state = receiveIncoming(state, ring("b", 2, "7745552222", 3)).state;
    expect(callOnLine(state, 1)?.key).toBe("a");
    expect(callOnLine(state, 2)?.key).toBe("b");
    expect(waitingCallCount(state)).toBe(2);
  });

  it("ignores a repeated packet but not a new call from the same customer (test 14, §17)", () => {
    let state = receiveIncoming(initialPhoneState(), ring("a", 1, "5085551234")).state;
    const repeat = receiveIncoming(state, ring("a", 1, "5085551234", 1));
    expect(repeat.duplicate).toBe(true);
    const sameNumberNoId = receiveIncoming(state, ring("a2", 1, "508-555-1234", 4));
    expect(sameNumberNoId.duplicate).toBe(true);
    // They hung up (the box reports the end) and called back.
    state = applyServerCall(state, serverCall({ ended_at: at(20) }));
    const callback = receiveIncoming(state, ring("c", 1, "5085551234", 25));
    expect(callback.duplicate).toBe(false);
    // Much later, with no end record, it is also a new call.
    const later = receiveIncoming(initialPhoneState(), ring("d", 1, "5085551234", 0));
    expect(receiveIncoming(later.state, ring("e", 1, "5085551234", 120)).duplicate).toBe(false);
  });

  it("lands the Realtime echo of this register's own ring on the same card", () => {
    const { state } = receiveIncoming(initialPhoneState(), ring("a", 1, "5085551234"));
    const echo = receiveIncoming(state, { ...ring("a", 1, "5085551234"), source: "cloud", serverCallId: "63000000-0000-4000-8000-0000000000aa" });
    expect(echo.duplicate).toBe(true);
    expect(Object.keys(echo.state.calls)).toEqual(["a"]);
    expect(echo.state.calls.a!.serverId).toBe("63000000-0000-4000-8000-0000000000aa");
  });

  it("enriches with the customer, or reports new caller / choose (§33)", () => {
    let state = receiveIncoming(initialPhoneState(), ring("a", 1, "5085551234")).state;
    state = applyServerCall(state, serverCall());
    expect(matchOutcome(state.calls.a!)).toBe("existing");
    state = applyServerCall(state, serverCall({ matches: [] }));
    expect(matchOutcome(state.calls.a!)).toBe("new_caller");
    state = applyServerCall(state, serverCall({ matches: [rita, { ...rita, id: "63000000-0000-4000-8000-000000000002", first_name: "Ron" }] }));
    expect(matchOutcome(state.calls.a!)).toBe("choose");
  });

  it("dismisses (test 12) and expires (test 13) without touching the other line", () => {
    let state = receiveIncoming(initialPhoneState(2, 10), ring("a", 1, "5085551234")).state;
    state = receiveIncoming(state, ring("b", 2, "7745552222", 1)).state;
    state = setStatus(state, "a", "dismissed");
    expect(callOnLine(state, 1)).toBeNull();
    expect(callOnLine(state, 2)?.key).toBe("b");
    expect(expiredKeys(state, t0 + 9 * 60_000)).toEqual([]);
    expect(expiredKeys(state, t0 + 11 * 60_000)).toEqual(["b"]);
  });

  it("counts only calls still waiting for someone in PHONE (n)", () => {
    let state = receiveIncoming(initialPhoneState(), ring("a", 1, "5085551234")).state;
    state = receiveIncoming(state, ring("b", 2, "7745552222", 1)).state;
    state = setStatus(state, "a", "order_started");
    expect(waitingCallCount(state)).toBe(1);
    expect(callOnLine(state, 1)?.status).toBe("order_started");
  });

  it("keeps a ring the server has not heard of when the board comes back empty (§30)", () => {
    const state = receiveIncoming(initialPhoneState(), ring("offline", 1, "5085551234")).state;
    const board: PhoneBoard = { expire_minutes: 10, server_time: at(5), lines: [{ line_number: 1, label: "Line 1", phone_number: "", call: null }, { line_number: 2, label: "Line 2", phone_number: "", call: null }], recent: [] };
    const next = applyBoard(state, board);
    expect(callOnLine(next, 1)?.key).toBe("offline");
    // Once recorded, the server is the truth: an empty line means it is over.
    const synced = applyBoard(applyServerCall(next, serverCall({ event_key: "offline", status: "dismissed" })), board);
    expect(callOnLine(synced, 1)).toBeNull();
  });
});
