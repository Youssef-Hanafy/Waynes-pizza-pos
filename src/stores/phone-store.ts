"use client";

import type { HardwareEventBus } from "@/hardware/event-bus";
import type { IncomingCallEvent } from "@/hardware/types";
import {
  applyBoard, applyServerCall, callOnLine, expiredKeys, hasUnclaimedCall, initialPhoneState, patchCall, receiveIncoming, setStatus, waitingCallCount,
  type PhoneCallView, type PhoneState,
} from "@/lib/phone/phone-state";
import { callActionResultSchema, phoneBoardSchema, posCallRecordedSchema, type CallAction, type PhoneCall } from "@/lib/phone/schemas";
import { createStore, useStore } from "./create-store";

/**
 * Phone state for this register (§16, §32).
 *
 *   hardware event bus ──► receiveIncomingCall ──► card on its line, at once
 *                                   └──► record on the server ──► customer matches arrive
 *
 * The card never waits for the network (§55).  Customer enrichment follows as
 * soon as the server answers; if it cannot answer, the card stays and says so.
 */

const serverSnapshot = initialPhoneState();
export const phoneStore = createStore<PhoneState>(serverSnapshot);

const TERMINAL_KEY = "wayne.pos.terminal";
const AUTO_OPEN_KEY = "wayne.pos.autoOpenCalls";

/**
 * Auto pick-up: when Line 1 or Line 2 rings and this register is idle, the
 * call opens on screen by itself (Thrive's caller ID pop-up).  On by default;
 * each register can switch it off in POS -> More (e.g. a kitchen tablet).
 */
export function getAutoOpenCalls(): boolean {
  try {
    return window.localStorage.getItem(AUTO_OPEN_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAutoOpenCalls(on: boolean) {
  try {
    window.localStorage.setItem(AUTO_OPEN_KEY, on ? "on" : "off");
  } catch {
    // Not persisted; the default (on) is used.
  }
}

/** This register's name, shown to the others when it claims a call (§22). */
export function getTerminalLabel(): string {
  try {
    return window.localStorage.getItem(TERMINAL_KEY)?.trim() || "Register 1";
  } catch {
    return "Register 1";
  }
}

export function setTerminalLabel(label: string) {
  try {
    window.localStorage.setItem(TERMINAL_KEY, label.trim().slice(0, 60) || "Register 1");
  } catch {
    // Not persisted; the default is used.
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorText(body: unknown, fallback: string) {
  return body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : fallback;
}

let refreshing: Promise<void> | null = null;
let refreshAgain = false;

export type ClaimOutcome = { ok: true; call: PhoneCallView } | { ok: false; reason: "claimed" | "closed" | "offline"; call?: PhoneCallView; message: string };

export const phoneActions = {
  /** Pull the whole board once (on start, on a Realtime change, on reconnect). Never on a timer. */
  async refresh(): Promise<void> {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = (async () => {
      try {
        do {
          refreshAgain = false;
          const response = await fetch("/api/phone/board", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
          const parsed = phoneBoardSchema.safeParse(await readJson(response));
          if (response.ok && parsed.success) phoneStore.set((state) => applyBoard(state, parsed.data));
        } while (refreshAgain);
      } catch {
        // Offline: local cards stay; the next change or reconnect refreshes.
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  },

  /** receiveIncomingCall (§32). */
  receiveIncomingCall(event: IncomingCallEvent) {
    const result = receiveIncoming(phoneStore.get(), event);
    phoneStore.set(result.state);
    if (result.duplicate) return;
    if (event.source === "cloud") {
      // Recorded elsewhere (bridge or another register): fetch its matches once.
      void phoneActions.refresh();
      return;
    }
    void phoneActions.record(result.call.key, event);
  },

  /** Record a ring this register heard, then show who it is. */
  async record(key: string, event: IncomingCallEvent) {
    try {
      const response = await fetch("/api/phone/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_key: event.id, line_number: event.line, caller_number: event.phoneNumber, caller_name: event.callerName ?? "",
          device_id: event.deviceId ?? "", occurred_at: event.occurredAt, raw_record: event.rawPayload ?? "",
          source: event.source === "android_native" ? "android_native" : "simulated",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await readJson(response);
      const parsed = posCallRecordedSchema.safeParse(body);
      if (!response.ok || !parsed.success || !parsed.data.call) throw new Error(errorText(body, "The call could not be looked up."));
      phoneStore.set((state) => applyServerCall(state, parsed.data.call as PhoneCall));
    } catch (error) {
      phoneStore.set((state) => patchCall(state, key, {
        lookup: "failed",
        unsynced: true,
        syncError: error instanceof Error ? error.message : "The call could not be looked up.",
      }));
    }
  },

  /** Retry every ring that never reached the server (after the connection returns). */
  retryUnsynced() {
    for (const call of Object.values(phoneStore.get().calls)) {
      if (!call.unsynced || !["incoming", "selected"].includes(call.status)) continue;
      phoneStore.set((state) => patchCall(state, call.key, { lookup: "pending", syncError: "" }));
      void phoneActions.record(call.key, {
        id: call.key, line: call.line as IncomingCallEvent["line"], phoneNumber: call.phoneNumber, callerName: call.callerName,
        occurredAt: call.occurredAt, source: call.simulated ? "simulated" : "android_native",
      });
    }
  },

  async act(key: string, action: CallAction, force = false): Promise<ClaimOutcome> {
    const state = phoneStore.get();
    const call = state.calls[key];
    // A call from the recent list may not have a card yet (e.g. reopening it).
    const serverId = call?.serverId ?? state.recent.find((entry) => entry.event_key === key)?.id ?? null;
    if (!call && !serverId) return { ok: false, reason: "closed", message: "That call is no longer on screen." };
    if (call && !serverId) {
      // Not recorded yet: act locally so the cashier is never blocked (§30).
      if (action === "dismiss") phoneStore.set((state) => setStatus(state, key, "dismissed"));
      if (action === "expire") phoneStore.set((state) => setStatus(state, key, "expired"));
      if (action === "start_order") phoneStore.set((state) => setStatus(state, key, "order_started"));
      if (action === "claim") phoneStore.set((state) => setStatus(state, key, "selected"));
      return { ok: true, call: phoneStore.get().calls[key]! };
    }
    try {
      const response = await fetch(`/api/phone/calls/${serverId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, terminal: getTerminalLabel(), force }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await readJson(response);
      const parsed = callActionResultSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw new Error(errorText(body, "The phone line could not be updated."));
      phoneStore.set((state) => applyServerCall(state, parsed.data.call));
      const updated = phoneStore.get().calls[key]!;
      if (!parsed.data.ok) {
        const who = [updated.claimedByName, updated.claimedTerminal].filter(Boolean).join(" on ");
        return parsed.data.reason === "claimed"
          ? { ok: false, reason: "claimed", call: updated, message: `${who || "Another register"} is already taking this call.` }
          : { ok: false, reason: "closed", call: updated, message: "This call is already finished." };
      }
      return { ok: true, call: updated };
    } catch (error) {
      return { ok: false, reason: "offline", message: error instanceof Error ? error.message : "The phone line could not be updated." };
    }
  },

  /** claimCall (§32): mark it as being handled by this register — the multi-register lock. */
  claimCall(key: string, force = false) {
    return phoneActions.act(key, "claim", force);
  },
  /** selectCall (§32): opening a line selects it, which is a claim. */
  selectCall(key: string) {
    return phoneActions.act(key, "claim");
  },
  releaseCall(key: string) {
    return phoneActions.act(key, "release");
  },
  dismissCall(key: string, force = false) {
    return phoneActions.act(key, "dismiss", force);
  },
  expireOldCall(key: string) {
    return phoneActions.act(key, "expire");
  },
  reopenCall(key: string) {
    return phoneActions.act(key, "reopen");
  },
  /** startOrderFromCall (§32): the order screen does the rest with the order store. */
  startOrderFromCall(key: string, force = false) {
    return phoneActions.act(key, "start_order", force);
  },
  /** clearCompletedCall (§34.9): the server closed it when the order was placed. */
  clearCompletedCall(key: string) {
    phoneStore.set((state) => setStatus(state, key, "completed"));
    void phoneActions.refresh();
  },

  /** Quiet cards nobody took (§34.6). Driven by the screen clock, not a server poll. */
  expireStale(now = Date.now()) {
    for (const key of expiredKeys(phoneStore.get(), now)) {
      phoneStore.set((state) => setStatus(state, key, "expired"));
      void phoneActions.act(key, "expire");
    }
  },

  configure(lineCount: number, expireMinutes: number) {
    phoneStore.set((state) => (state.hydrated ? state : { ...initialPhoneState(lineCount, expireMinutes), calls: state.calls, lineCalls: { ...initialPhoneState(lineCount).lineCalls, ...state.lineCalls } }));
  },
};

/** Connect the phone store to the hardware event bus. Returns the disconnect. */
export function connectPhoneStore(bus: HardwareEventBus) {
  const offIncoming = bus.on("caller.incoming", (event) => phoneActions.receiveIncomingCall(event.payload));
  const offChanged = bus.on("caller.changed", () => void phoneActions.refresh());
  return () => {
    offIncoming();
    offChanged();
  };
}

export function usePhoneState() {
  return useStore(phoneStore, (state) => state, serverSnapshot);
}

export function usePhoneBadge() {
  const waiting = useStore(phoneStore, waitingCallCount, serverSnapshot);
  const ringing = useStore(phoneStore, hasUnclaimedCall, serverSnapshot);
  return { waiting, ringing };
}

export { callOnLine };
