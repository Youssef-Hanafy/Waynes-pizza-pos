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
  // A few seconds' worth of steps go in one request (owner, 2026-10-24: less Vercel compute).
  timer = window.setTimeout(flush, 5000);
}

/**
 * Application lifecycle events (app.*) are written to this register's storage FIRST
 * and sent straight away (2026-10-31): the 5-second batch above was lost whenever
 * the page reloaded, which is exactly when an update happens — so in 30 days not one
 * app.reload / app.update_confirmed reached the server.  The next page sends anything
 * still waiting.  Diagnostics only: build ids and states, never order or card data.
 */
const OUTBOX = "wayne.pos.device-log-outbox.v1";
let outboxSending = false;
function readOutbox(): (Entry & { id: string })[] {
  try { const list = JSON.parse(window.localStorage.getItem(OUTBOX) || "[]") as unknown; return Array.isArray(list) ? list.slice(-60) as (Entry & { id: string })[] : []; } catch { return []; }
}
function writeOutbox(list: (Entry & { id: string })[]) { try { window.localStorage.setItem(OUTBOX, JSON.stringify(list.slice(-60))); } catch { /* storage full: the in-memory batch still tries */ } }
export function flushDeviceOutbox() {
  if (typeof window === "undefined" || outboxSending || typeof fetch !== "function") return;
  const pending = readOutbox();
  if (!pending.length) return;
  outboxSending = true;
  const sent = new Set(pending.slice(0, 40).map((entry) => entry.id));
  const events = pending.slice(0, 40).map(({ id, ...entry }) => ({ ...entry, detail: { ...entry.detail, outbox_id: id } }));
  try {
    void fetch("/api/pos/device-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }), cache: "no-store", keepalive: true, credentials: "same-origin" })
      .then((response) => { if (response.ok) writeOutbox(readOutbox().filter((entry) => !sent.has(entry.id))); })
      .catch(() => undefined)
      .finally(() => { outboxSending = false; if (readOutbox().some((entry) => !sent.has(entry.id))) window.setTimeout(flushDeviceOutbox, 1000); });
  } catch { outboxSending = false; }
}

export function logDevice(kind: string, message = "", detail: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  if (kind.startsWith("app.")) {
    writeOutbox([...readOutbox(), { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, kind, message: String(message).slice(0, 4000), detail, at: new Date().toISOString() }]);
    flushDeviceOutbox();
    return;
  }
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
