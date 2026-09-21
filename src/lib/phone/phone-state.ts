import type { IncomingCallEvent } from "@/hardware/types";
import type { PosCustomer } from "@/lib/pos/schemas";
import { normalizePhone } from "./normalize";
import type { CallStatus, PhoneBoard, PhoneCall, RecentCall } from "./schemas";

/**
 * The phone screen's state, as pure functions so every rule in the build
 * sheet can be tested without a browser (§16, §17, §34).
 *
 * Calls are keyed by their event key — the id the provider gave the ring — so
 * the local card, the server row and the Realtime echo of that row all land on
 * the same card and never show twice.
 */

export type LookupState = "pending" | "done" | "failed";

export type PhoneCallView = {
  key: string;
  serverId: string | null;
  line: number;
  phoneNumber: string;
  normalizedNumber: string | null;
  callerName: string;
  occurredAt: string;
  /** When it became live on the line (ring or reopen); expiry counts from here. */
  surfacedAt: string;
  endedAt: string | null;
  status: CallStatus;
  simulated: boolean;
  lookup: LookupState;
  matches: PosCustomer[];
  customerId: string | null;
  claimedById: string | null;
  claimedByName: string | null;
  claimedTerminal: string;
  orderId: string | null;
  orderNumber: string | null;
  /** Not yet recorded on the server (offline, or the request is in flight). */
  unsynced: boolean;
  syncError: string;
};

export type PhoneLineInfo = { line: number; label: string };

export type PhoneState = {
  lines: PhoneLineInfo[];
  calls: Record<string, PhoneCallView>;
  /** Line number → the key of the call currently on it. Lines never share (§16). */
  lineCalls: Record<number, string | null>;
  recent: RecentCall[];
  expireMinutes: number;
  hydrated: boolean;
};

export const ACTIVE_STATUSES: readonly CallStatus[] = ["incoming", "selected", "order_started"];
/** How close two identical rings must be to count as one repeated packet (§17). */
export const DUPLICATE_WINDOW_MS = 10_000;

export function initialPhoneState(lineCount = 2, expireMinutes = 10): PhoneState {
  const lines = Array.from({ length: lineCount }, (_, index) => ({ line: index + 1, label: `Line ${index + 1}` }));
  return { lines, calls: {}, lineCalls: Object.fromEntries(lines.map((line) => [line.line, null])), recent: [], expireMinutes, hydrated: false };
}

export function isActive(call: PhoneCallView | null | undefined): call is PhoneCallView {
  return Boolean(call && ACTIVE_STATUSES.includes(call.status));
}

export function callOnLine(state: PhoneState, line: number): PhoneCallView | null {
  const key = state.lineCalls[line];
  const call = key ? state.calls[key] : undefined;
  return isActive(call) ? call : null;
}

/** Calls still waiting for someone: what the header's PHONE (n) counts (§6). */
export function waitingCallCount(state: PhoneState): number {
  return state.lines.filter((line) => {
    const call = callOnLine(state, line.line);
    return call !== null && (call.status === "incoming" || call.status === "selected");
  }).length;
}

/** True when at least one line is ringing and nobody has picked it up yet. */
export function hasUnclaimedCall(state: PhoneState): boolean {
  return state.lines.some((line) => callOnLine(state, line.line)?.status === "incoming");
}

function fromEvent(event: IncomingCallEvent): PhoneCallView {
  return {
    key: event.id,
    serverId: event.serverCallId ?? null,
    line: event.line,
    phoneNumber: event.phoneNumber,
    normalizedNumber: normalizePhone(event.phoneNumber),
    callerName: event.callerName ?? "",
    occurredAt: event.occurredAt,
    surfacedAt: event.occurredAt,
    endedAt: null,
    status: "incoming",
    simulated: event.source === "simulated",
    lookup: "pending",
    matches: [],
    customerId: null,
    claimedById: null,
    claimedByName: null,
    claimedTerminal: "",
    orderId: null,
    orderNumber: null,
    unsynced: event.source !== "cloud",
    syncError: "",
  };
}

export function fromServerCall(call: PhoneCall): PhoneCallView {
  return {
    key: call.event_key,
    serverId: call.id,
    line: call.line_number,
    phoneNumber: call.caller_number ?? call.caller_number_raw,
    normalizedNumber: call.caller_number,
    callerName: call.caller_name,
    occurredAt: call.started_at,
    surfacedAt: call.surfaced_at ?? call.started_at,
    endedAt: call.ended_at,
    status: call.status,
    simulated: call.simulated,
    lookup: "done",
    matches: call.matches,
    customerId: call.customer_id,
    claimedById: call.claimed_by_id,
    claimedByName: call.claimed_by_name,
    claimedTerminal: call.claimed_terminal,
    orderId: call.order_id,
    orderNumber: call.order_number,
    unsynced: false,
    syncError: "",
  };
}

/**
 * Is this ring the same event as one already on screen?  Same event id always
 * is.  Otherwise only the same number on the same line, still open, within a
 * few seconds — so a customer who hangs up and calls back is a new card (§17).
 */
export function findDuplicate(state: PhoneState, event: IncomingCallEvent): PhoneCallView | null {
  const byKey = state.calls[event.id];
  if (byKey) return byKey;
  const normalized = normalizePhone(event.phoneNumber);
  const at = Date.parse(event.occurredAt);
  for (const call of Object.values(state.calls)) {
    if (call.line !== event.line || call.endedAt) continue;
    const sameNumber = normalized !== null ? call.normalizedNumber === normalized : call.phoneNumber === event.phoneNumber.trim();
    if (!sameNumber) continue;
    if (Math.abs(Date.parse(call.occurredAt) - at) <= DUPLICATE_WINDOW_MS) return call;
  }
  return null;
}

/** receiveIncomingCall (§32): show the ring on its own line immediately (§55). */
export function receiveIncoming(state: PhoneState, event: IncomingCallEvent): { state: PhoneState; call: PhoneCallView; duplicate: boolean } {
  const duplicate = findDuplicate(state, event);
  if (duplicate) {
    // The cloud echo of a ring this register recorded carries the server id.
    if (event.serverCallId && !duplicate.serverId) {
      const merged = { ...duplicate, serverId: event.serverCallId, unsynced: false };
      return { state: { ...state, calls: { ...state.calls, [duplicate.key]: merged } }, call: merged, duplicate: true };
    }
    return { state, call: duplicate, duplicate: true };
  }
  const call = fromEvent(event);
  const lines = state.lines.some((line) => line.line === event.line)
    ? state.lines
    : [...state.lines, { line: event.line, label: `Line ${event.line}` }].sort((a, b) => a.line - b.line);
  return {
    state: { ...state, lines, calls: { ...state.calls, [call.key]: call }, lineCalls: { ...state.lineCalls, [event.line]: call.key } },
    call,
    duplicate: false,
  };
}

/** Merge a call the server returned (after recording, claiming, etc.). */
export function applyServerCall(state: PhoneState, serverCall: PhoneCall): PhoneState {
  const call = fromServerCall(serverCall);
  const current = state.lineCalls[call.line];
  const currentCall = current ? state.calls[current] : undefined;
  // It takes the line only if it is the newest thing that line has seen.
  const takesLine = !currentCall || currentCall.key === call.key || Date.parse(call.surfacedAt) >= Date.parse(currentCall.surfacedAt);
  return {
    ...state,
    calls: { ...state.calls, [call.key]: call },
    lineCalls: ACTIVE_STATUSES.includes(call.status)
      ? (takesLine ? { ...state.lineCalls, [call.line]: call.key } : state.lineCalls)
      : (current === call.key ? { ...state.lineCalls, [call.line]: null } : state.lineCalls),
  };
}

export function patchCall(state: PhoneState, key: string, patch: Partial<PhoneCallView>): PhoneState {
  const call = state.calls[key];
  if (!call) return state;
  return { ...state, calls: { ...state.calls, [key]: { ...call, ...patch } } };
}

/**
 * The server's board is the truth for everything it knows about.  A ring this
 * register has shown but not yet managed to record (offline) is kept, so a
 * dropped connection never hides a caller (§30).
 */
export function applyBoard(state: PhoneState, board: PhoneBoard): PhoneState {
  const calls = { ...state.calls };
  const lineCalls: Record<number, string | null> = {};
  const lines = board.lines.map((line) => ({ line: line.line_number, label: line.label }));
  for (const line of board.lines) {
    if (line.call) {
      calls[line.call.event_key] = fromServerCall(line.call);
      lineCalls[line.line_number] = line.call.event_key;
    } else {
      const localKey = state.lineCalls[line.line_number];
      const local = localKey ? state.calls[localKey] : undefined;
      lineCalls[line.line_number] = local && local.unsynced && isActive(local) ? local.key : null;
    }
  }
  // Calls the server has closed are closed here too.
  for (const recent of board.recent) {
    const local = calls[recent.event_key];
    if (local && local.status !== recent.status && !ACTIVE_STATUSES.includes(recent.status)) {
      calls[recent.event_key] = { ...local, status: recent.status, orderId: recent.order_id, orderNumber: recent.order_number };
    }
  }
  return { ...state, lines, calls, lineCalls, recent: board.recent, expireMinutes: board.expire_minutes, hydrated: true };
}

/** expireOldCall (§34.6): cards nobody took go quiet after the configured time. */
export function expiredKeys(state: PhoneState, now: number): string[] {
  const limit = state.expireMinutes * 60_000;
  return Object.values(state.calls)
    .filter((call) => (call.status === "incoming" || call.status === "selected") && now - Date.parse(call.surfacedAt) > limit)
    .map((call) => call.key);
}

export function setStatus(state: PhoneState, key: string, status: CallStatus): PhoneState {
  const call = state.calls[key];
  if (!call) return state;
  const next = patchCall(state, key, { status });
  if (!ACTIVE_STATUSES.includes(status) && next.lineCalls[call.line] === key) {
    return { ...next, lineCalls: { ...next.lineCalls, [call.line]: null } };
  }
  return next;
}

/** The customers a ring matched, and what to do about them (§33, §54). */
export function matchOutcome(call: PhoneCallView): "looking_up" | "new_caller" | "existing" | "choose" {
  if (call.lookup === "pending") return "looking_up";
  if (!call.matches.length) return "new_caller";
  return call.matches.length === 1 ? "existing" : "choose";
}
