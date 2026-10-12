"use client";

import { useSyncExternalStore } from "react";
import { displayPublishResultSchema, displayStateSchema, type DisplayState } from "@/lib/pos/customer-display";
import { getTerminalLabel } from "@/stores/phone-store";
import { uuid } from "@/lib/uuid";

/**
 * The register's side of the customer screen (owner, 2026-10-11).
 *
 * The register keeps one "what the customer should see" state and sends it to
 * the server whenever it changes, plus a heartbeat every few seconds.  While it
 * is waiting on the customer (a tip, a signature) it sends every second, and
 * each send brings back the customer's answer.
 *
 * The screen is found by this register's name (More → This register).
 */
type Answer = Record<string, unknown>;
type Waiter = { requestId: string; resolve: (answer: Answer | null) => void };

type LinkState = { screenOnline: boolean; key: string };

/** The store's tip buttons (Admin → Settings), set once by the POS shell. */
let tipOptions: { tip_percentages?: number[]; tip_amounts_cents?: number[] } = {};

export function setCustomerTipOptions(percentages: number[], amountsCents: number[]) {
  tipOptions = {
    ...(percentages.length ? { tip_percentages: percentages.slice(0, 4) } : {}),
    tip_amounts_cents: amountsCents.slice(0, 6),
  };
}

let current: DisplayState = displayStateSchema.parse({});
// Nothing to show yet: the first send is a heartbeat, so opening a second POS
// (or reloading) never blanks a screen another register is using.
let dirty = false;
/** This copy of the POS.  The screen follows whichever POS last really changed it. */
let publisherId = "";
let lastSent = 0;
let timer: number | null = null;
let sending = false;
let waiter: Waiter | null = null;
let snapshot: LinkState = { screenOnline: false, key: "" };
const listeners = new Set<() => void>();

function emit(next: Partial<LinkState>) {
  const merged = { ...snapshot, ...next };
  if (merged.screenOnline === snapshot.screenOnline && merged.key === snapshot.key) return;
  snapshot = merged;
  for (const listener of listeners) listener();
}

async function send() {
  if (sending || typeof window === "undefined") return;
  const key = getTerminalLabel();
  if (!publisherId) publisherId = uuid();
  const changed = dirty;
  sending = true;
  dirty = false;
  lastSent = Date.now();
  try {
    const response = await fetch("/api/pos/display", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "publish", key, state: current, publisher: publisherId, changed }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) { emit({ screenOnline: false, key }); return; }
    const parsed = displayPublishResultSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return;
    emit({ screenOnline: parsed.data.screen_online, key });
    const answer = parsed.data.response;
    if (waiter && typeof answer.request_id === "string" && answer.request_id === waiter.requestId) {
      const done = waiter;
      waiter = null;
      done.resolve(answer);
    }
  } catch {
    emit({ screenOnline: false });
  } finally {
    sending = false;
  }
}

function tick() {
  const interval = waiter ? 1000 : 4000;
  if (dirty || Date.now() - lastSent >= interval) void send();
}

/** Start talking to the customer screen (once, from the POS shell). Returns the stop. */
export function startCustomerDisplayLink() {
  if (timer !== null || typeof window === "undefined") return stopCustomerDisplayLink;
  timer = window.setInterval(tick, 500);
  void send();
  return stopCustomerDisplayLink;
}

/**
 * Stop publishing (the POS was left, e.g. this tablet became the customer
 * screen).  Before this, a tablet that opened the POS and then the customer
 * screen kept sending an empty screen every 4 s — the flicker (2026-10-11).
 */
export function stopCustomerDisplayLink() {
  if (timer !== null && typeof window !== "undefined") window.clearInterval(timer);
  timer = null;
  clearCustomerRequest();
}

/** Show this on the customer screen (anything left out keeps its default). */
export function showOnCustomerScreen(next: Partial<DisplayState>) {
  // A request in progress (tip / signature) isn't replaced by ticket updates.
  if (waiter && next.phase !== "tip" && next.phase !== "sign" && next.request_id !== current.request_id) return;
  const parsed = displayStateSchema.safeParse({ ...next });
  if (!parsed.success) return;
  if (JSON.stringify(parsed.data) === JSON.stringify(current)) return;
  current = parsed.data;
  dirty = true;
}

/**
 * Ask the customer something on the screen and wait for the answer.  Resolves
 * null if cancelled (the cashier skipped it).
 */
export function askCustomer(next: Partial<DisplayState> & { phase: "tip" | "sign" }): { answer: Promise<Answer | null>; cancel: () => void } {
  if (waiter) { const old = waiter; waiter = null; old.resolve(null); }
  const requestId = uuid();
  current = displayStateSchema.parse({ ...(next.phase === "tip" ? tipOptions : {}), ...next, request_id: requestId });
  dirty = true;
  let cancel = () => {};
  const answer = new Promise<Answer | null>((resolve) => {
    waiter = { requestId, resolve };
    cancel = () => {
      if (waiter?.requestId === requestId) { waiter = null; resolve(null); }
    };
  });
  return { answer, cancel };
}

export function clearCustomerRequest() {
  if (waiter) { const old = waiter; waiter = null; old.resolve(null); }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether a customer screen is facing this register right now. */
export function useCustomerScreen(): LinkState {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
