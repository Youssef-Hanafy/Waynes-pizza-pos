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
const KEEP_FOR_MS = 3 * 24 * 60 * 60_000;
const RETRY_EVERY_MS = 60_000;

type Pending = { payload: PosSaveCustomer; queuedAt: number };

/** What each phone number was last saved as on this register, so the same save isn't sent twice. */
const lastSaved = new Map<string, string>();
const inFlight = new Map<string, Promise<PosCustomer | null>>();

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

export function readPendingSaves(): Pending[] {
  try {
    const raw = storage()?.getItem(QUEUE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter((item): item is Pending => Boolean(item && typeof item === "object"
      && typeof (item as Pending).queuedAt === "number" && now - (item as Pending).queuedAt < KEEP_FOR_MS
      && typeof (item as Pending).payload?.phone === "string"));
  } catch { return []; }
}

function writePendingSaves(items: Pending[]) {
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
  startCustomerSaveRetry();
  const signature = JSON.stringify(payload);
  if (lastSaved.get(payload.phone) === signature) return Promise.resolve(null);
  const running = inFlight.get(signature);
  if (running) return running;
  const attempt = (async () => {
    try {
      const saved = await rememberCustomer(payload);
      lastSaved.set(payload.phone, signature);
      writePendingSaves(readPendingSaves().filter((item) => item.payload.phone !== payload.phone || JSON.stringify(item.payload) !== signature));
      return saved;
    } catch {
      writePendingSaves(mergePending(readPendingSaves(), payload));
      notify(`${label(payload)} isn't saved yet — the POS will keep trying by itself.`, "warn");
      return null;
    } finally {
      inFlight.delete(signature);
    }
  })();
  inFlight.set(signature, attempt);
  return attempt;
}

let flushing = false;
/** Send the saves still waiting on this register. */
export async function flushCustomerSaves() {
  if (flushing) return;
  flushing = true;
  try {
    const waiting = readPendingSaves();
    writePendingSaves(waiting); // drops expired ones
    for (const item of waiting) {
      try {
        await rememberCustomer(item.payload);
        lastSaved.set(item.payload.phone, JSON.stringify(item.payload));
        writePendingSaves(readPendingSaves().filter((other) => other.payload.phone !== item.payload.phone || other.queuedAt > item.queuedAt));
        notify(`✓ Saved ${label(item.payload)}`);
      } catch {
        continue; // still not through: tried again next time
      }
    }
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
  void flushCustomerSaves();
}
