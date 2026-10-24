"use client";

import { createStore, useStore } from "./create-store";

/**
 * Can this register reach the POS server right now? (owner, 2026-10-24)
 *
 * The browser's own online flag only knows about the Wi-Fi / Ethernet link.
 * At Wayne's the link can be up while the internet is down, so this also
 * learns from real requests: any request that never got an answer marks the
 * server unreachable, and a tiny probe of /api/version (a static file — it
 * costs no server time) checks every 10 seconds until it answers again.
 * Whoever needs to know subscribes: the offline orders sync, the header
 * warning, the background refreshes that must not run while offline.
 */
type Connectivity = { reachable: boolean; since: number };

const initial: Connectivity = { reachable: true, since: 0 };
export const connectivityStore = createStore<Connectivity>(initial);

const PROBE_EVERY_MS = 10_000;
let probeTimer: number | null = null;
let probing = false;
let wired = false;

function set(reachable: boolean) {
  if (connectivityStore.get().reachable === reachable) return;
  connectivityStore.set({ reachable, since: Date.now() });
  if (reachable) {
    stopProbe();
    if (typeof window !== "undefined") window.dispatchEvent(new Event("wayne:reconnected"));
  } else {
    startProbe();
  }
}

/** A request got an answer from the server (any status): it is reachable. */
export function reportServerOk() {
  set(true);
}

/** A request got no answer at all (no network, timed out). */
export function reportNetworkFailure() {
  set(false);
}

export function isServerReachable() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  return connectivityStore.get().reachable;
}

/** Ask the server once. True when it answered. */
export async function probeServer(): Promise<boolean> {
  if (probing) return connectivityStore.get().reachable;
  probing = true;
  try {
    const response = await fetch("/api/version", { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (response.ok || response.status < 500) { set(true); return true; }
    set(false);
    return false;
  } catch {
    set(false);
    return false;
  } finally {
    probing = false;
  }
}

function startProbe() {
  if (typeof window === "undefined" || probeTimer !== null) return;
  probeTimer = window.setInterval(() => { void probeServer(); }, PROBE_EVERY_MS);
}

function stopProbe() {
  if (probeTimer !== null) window.clearInterval(probeTimer);
  probeTimer = null;
}

/** Follow the device's own link state too (once per page). */
export function watchConnectivity() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  window.addEventListener("offline", () => set(false));
  window.addEventListener("online", () => { void probeServer(); });
  if (navigator.onLine === false) set(false);
}

/** Is a fetch error "no answer at all" (as opposed to the server saying no)? */
export function isNoAnswer(error: unknown) {
  return error instanceof TypeError || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"));
}

export function useConnectivity() {
  return useStore(connectivityStore, (state) => state, initial);
}
