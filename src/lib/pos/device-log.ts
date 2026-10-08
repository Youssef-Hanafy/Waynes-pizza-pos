"use client";

/**
 * Sends card-reader steps and POS page script errors to /api/pos/device-log,
 * so a problem on the counter tablet (no developer tools there) can be read
 * back exactly.  Best effort: batched, never throws, never blocks a sale.
 */
type Entry = { kind: string; message?: string; detail?: Record<string, unknown>; at: string };

let queue: Entry[] = [];
let timer: number | null = null;
let sentThisMinute = 0;
let minuteStarted = 0;

function flush() {
  timer = null;
  if (!queue.length || typeof fetch !== "function") return;
  const now = Date.now();
  if (now - minuteStarted > 60_000) { minuteStarted = now; sentThisMinute = 0; }
  if (sentThisMinute >= 20) { queue = []; return; } // a runaway loop must not flood the log
  sentThisMinute += 1;
  const events = queue.splice(0, 40);
  try {
    void fetch("/api/pos/device-log", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }), cache: "no-store", keepalive: true, credentials: "same-origin",
    }).catch(() => undefined);
  } catch { /* logging must never break the POS */ }
  if (queue.length) schedule();
}

function schedule() {
  if (timer !== null || typeof window === "undefined") return;
  timer = window.setTimeout(flush, 800);
}

export function logDevice(kind: string, message = "", detail: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  queue.push({ kind, message: String(message).slice(0, 4000), detail, at: new Date().toISOString() });
  if (queue.length > 200) queue = queue.slice(-200);
  schedule();
}

let errorsInstalled = false;

/** Script errors on the POS page (old Android WebViews fail here silently otherwise). */
export function installDeviceErrorLogging() {
  if (errorsInstalled || typeof window === "undefined") return;
  errorsInstalled = true;
  window.addEventListener("error", (event) => {
    logDevice("page.error", event.message || "Script error", { source: event.filename ?? "", line: event.lineno ?? null, column: event.colno ?? null, stack: event.error instanceof Error ? String(event.error.stack ?? "").slice(0, 1500) : "" });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as unknown;
    logDevice("page.unhandled_rejection", reason instanceof Error ? reason.message : String(reason), { stack: reason instanceof Error ? String(reason.stack ?? "").slice(0, 1500) : "" });
  });
}
