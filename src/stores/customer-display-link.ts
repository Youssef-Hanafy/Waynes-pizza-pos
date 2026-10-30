"use client";

import { useSyncExternalStore } from "react";
import { displayStateSchema, type DisplayState } from "@/lib/pos/customer-display";
import { publishCustomerDisplay } from "@/lib/pos/customer-display-client";
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

type LinkState = {
  screenOnline: boolean;
  key: string;
  /** False when another POS using the same register name has taken over this customer screen. */
  showing: boolean;
};

/**
 * A screen counts as offline only after this long without a successful send
 * (owner, 2026-10-29: one dropped heartbeat on the Elo flipped the checkout
 * past the tip).  The server still says at once when the screen stops polling.
 */
const OFFLINE_AFTER_MS = 10_000;
/** A screen seen this recently is reconnecting, not missing: a card checkout still asks it for the tip. */
const RECENTLY_ONLINE_MS = 2 * 60_000;

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
let snapshot: LinkState = { screenOnline: false, key: "", showing: true };
let lastSentOk = 0;
let lastScreenOnline = 0;
let thanksShown = 0;
const listeners = new Set<() => void>();

function emit(next: Partial<LinkState>) {
  const merged = { ...snapshot, ...next };
  if (merged.screenOnline === snapshot.screenOnline && merged.key === snapshot.key && merged.showing === snapshot.showing) return;
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
    const result = await publishCustomerDisplay({ kind: "publish", key, state: current, publisher: publisherId, changed });
    lastSentOk = Date.now();
    if (result.screen_online) lastScreenOnline = lastSentOk;
    emit({ screenOnline: result.screen_online, key, showing: result.showing !== false });
    const answer = result.response;
    if (waiter && typeof answer.request_id === "string" && answer.request_id === waiter.requestId) {
      const done = waiter;
      waiter = null;
      done.resolve(answer);
    }
  } catch {
    dirty = dirty || changed;
    if (Date.now() - lastSentOk > OFFLINE_AFTER_MS) emit({ screenOnline: false });
  } finally {
    sending = false;
  }
}

function tick() {
  if (document.visibilityState !== "visible") return;
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
 * After a payment: "Thank you" (and the change) on the customer screen, then
 * back to the welcome screen — unless the next order is already showing
 * (owner, 2026-10-29: the timer blanked the next customer's ticket).
 */
export function thankCustomer(changeCents: number | null = null) {
  showOnCustomerScreen({ phase: "thanks", change_cents: changeCents });
  const shown = ++thanksShown;
  window.setTimeout(() => { if (shown === thanksShown && current.phase === "thanks") showOnCustomerScreen({ phase: "idle" }); }, 8000);
}

/** This register shows its screen again after another register with the same name took it over. */
export function reclaimCustomerScreen() {
  dirty = true;
}

/** Whether a customer screen answered this register in the last couple of minutes. */
export function customerScreenRecentlyOnline() {
  return lastScreenOnline > 0 && Date.now() - lastScreenOnline <= RECENTLY_ONLINE_MS;
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

/** The link's current state, outside React. */
export function customerScreenSnapshot(): LinkState {
  return snapshot;
}

/** Whether a customer screen is facing this register right now. */
export function useCustomerScreen(): LinkState {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
