"use client";

import { rememberCustomer } from "@/lib/pos/remember-customer";
import type { PosCustomer, PosSaveCustomer } from "@/lib/pos/schemas";
import { formatPhone } from "@/lib/phone/normalize";
import { notify } from "./draft-sync";

/**
 * Customer saves that never get lost (owner's dad, 2026-11-01: "I know I saved
 * them and they don't show up when they call").
 *
 * Every automatic save goes through here.  A save that fails (the Elo dropped
 * its connection, a timeout, the page reloading) is kept on the register and
 * tried again every minute and whenever the connection comes back, and the
 * cashier sees that it hasn't gone through yet — never a silent failure.
 */

const QUEUE_KEY = "wayne.pos.pendingCustomerSaves.v1";
const RETRY_EVERY_MS = 60_000;

type Pending = { payload: PosSaveCustomer; queuedAt: number };
let memoryPending: Pending[] | null = null;

/** What each phone number was last saved as on this register, so the same save isn't sent twice. */
const lastSaved = new Map<string, string>();
const inFlight = new Map<string, Promise<PosCustomer | null>>();

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

export function readPendingSaves(): Pending[] {
  try {
    const parsed: unknown = memoryPending ?? JSON.parse(storage()?.getItem(QUEUE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is Pending => Boolean(item && typeof item === "object"
      && typeof (item as Pending).queuedAt === "number"
      && typeof (item as Pending).payload?.phone === "string"));
  } catch { return []; }
}

function writePendingSaves(items: Pending[]) {
  memoryPending = items;
  try { storage()?.setItem(QUEUE_KEY, JSON.stringify(items)); } catch { /* storage full or blocked: the next save tries again */ }
}

/** One waiting save per phone number; a newer one keeps an address the older one had. */
export function mergePending(items: Pending[], payload: PosSaveCustomer, now = Date.now()): Pending[] {
  const older = items.find((item) => item.payload.phone === payload.phone)?.payload;
  const merged: PosSaveCustomer = {
    ...older, ...payload,
    first_name: payload.first_name || older?.first_name || "",
    last_name: payload.last_name || older?.last_name || "",
    email: payload.email || older?.email || "",
    ...(payload.address ?? older?.address ? { address: payload.address ?? older?.address } : {}),
  };
  return [...items.filter((item) => item.payload.phone !== payload.phone), { payload: merged, queuedAt: now }];
}

function label(payload: PosSaveCustomer) {
  return `${payload.first_name} ${payload.last_name}`.trim() || formatPhone(payload.phone);
}

/**
 * Save a customer without interrupting the cashier.  Returns the saved
 * profile, or null when it was already saved or is waiting to retry.
 */
export function saveCustomerQuietly(payload: PosSaveCustomer): Promise<PosCustomer | null> {
  const signature = JSON.stringify(payload);
  if (lastSaved.get(payload.phone) === signature && !readPendingSaves().some(item => item.payload.phone === payload.phone)) return Promise.resolve(null);
  // Persist before the request: a reload must not lose an unacknowledged save.
  writePendingSaves(mergePending(readPendingSaves(), payload));
  const attempt = sendPendingCustomer(payload.phone);
  startCustomerSaveRetry();
  return attempt;
}

/** Serialize each customer's writes so an older response cannot overwrite newer typing. */
function sendPendingCustomer(phone: string): Promise<PosCustomer | null> {
  const running = inFlight.get(phone);
  if (running) return running;
  const attempt = (async () => {
    let saved: PosCustomer | null = null;
    for (;;) {
      const item = readPendingSaves().find(item => item.payload.phone === phone);
      if (!item) return saved;
      const signature = JSON.stringify(item.payload);
      try {
        saved = await rememberCustomer(item.payload);
        lastSaved.set(phone, signature);
        // Only acknowledge this exact payload; keep anything typed during the request.
        writePendingSaves(readPendingSaves().filter(other => other.payload.phone !== phone || JSON.stringify(other.payload) !== signature));
      } catch {
        notify(`${label(item.payload)} isn't saved yet — the POS will keep trying by itself.`, "warn");
        return null;
      }
    }
  })().finally(() => inFlight.delete(phone));
  inFlight.set(phone, attempt);
  return attempt;
}

let flushing = false;
/** Send the saves still waiting on this register through the same per-phone queue. */
export async function flushCustomerSaves() {
  if (flushing) return;
  flushing = true;
  try {
    for (const item of readPendingSaves()) await sendPendingCustomer(item.payload.phone);
  } finally {
    flushing = false;
  }
}

let started = false;
/** Called when the POS opens: retries every minute and as soon as the connection is back. */
export function startCustomerSaveRetry() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("online", () => void flushCustomerSaves());
  window.setInterval(() => void flushCustomerSaves(), RETRY_EVERY_MS);
  queueMicrotask(() => void flushCustomerSaves());
}
