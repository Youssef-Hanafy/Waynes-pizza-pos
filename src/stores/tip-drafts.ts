"use client";

import { workspaceStorageKey } from "@/lib/tenancy/active-workspace";
import { getClientWorkspaceScope } from "@/lib/tenancy/client-scope";
import { logDevice } from "@/lib/pos/device-log";
import {
  applySaveResult, editTipDraft, mergeServerTipDrafts, parseLocalTipDrafts, removeTipDrafts, serverTipDraftSchema, unsyncedTipDrafts,
  type LocalTipDrafts, type TipScreen,
} from "@/lib/tips/drafts";
import { createStore, useStore } from "./create-store";
import { getDeviceId } from "./draft-sync";
import { getTerminalLabel } from "./phone-store";
import { isNoAnswer, reportNetworkFailure, reportServerOk } from "./connectivity";

/**
 * Tips typed from the slips, saved as they are typed (owner, 2026-10-28).
 *
 * POS → Tips and Deliveries → cash-out both read and write here instead of
 * keeping the boxes in the screen's own memory, so leaving the screen, a call
 * opening the Phone screen, a reload or a restart never loses a tip:
 *   1. every keystroke is written to this register's storage straight away
 *   2. a moment later it is sent to the server (newest value wins there too)
 *   3. offline it stays on the register and goes when the server answers again
 * Charging is still only Charge / Cash out; these are the boxes' contents.
 */

type State = { loaded: boolean; drafts: LocalTipDrafts; syncing: boolean; lastError: string };

const initial: State = { loaded: false, drafts: {}, syncing: false, lastError: "" };
export const tipDraftStore = createStore<State>(initial);

const SYNC_DELAY_MS = 600;
let storageKey = "";
let timer: number | null = null;
let syncing = false;
let started = false;

function key() {
  if (!storageKey) storageKey = workspaceStorageKey(getClientWorkspaceScope().workspaceId, "pos-tip-drafts.v1");
  return storageKey;
}

function persist(drafts: LocalTipDrafts) {
  try {
    window.localStorage.setItem(key(), JSON.stringify(drafts));
    return true;
  } catch {
    return false;
  }
}

function setDrafts(update: (drafts: LocalTipDrafts) => LocalTipDrafts) {
  const current = tipDraftStore.get();
  const next = update(current.drafts);
  if (next === current.drafts) return;
  // Written to the device before anything else happens, so it is there even if the app is closed this instant.
  const ok = persist(next);
  tipDraftStore.set({ ...current, drafts: next, lastError: ok ? current.lastError : "This register could not store the tip on the device (storage full?). It is still being sent to the server." });
}

/** Read what this register saved (once per page). */
export function loadTipDrafts() {
  if (typeof window === "undefined" || tipDraftStore.get().loaded) return;
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(key()); } catch { raw = null; }
  tipDraftStore.set({ ...tipDraftStore.get(), loaded: true, drafts: parseLocalTipDrafts(raw) });
  if (!started) {
    started = true;
    const kick = () => { void syncTipDrafts(); };
    window.addEventListener("wayne:reconnected", kick);
    window.addEventListener("online", kick);
    // Leaving or hiding the app: send what is waiting right away.
    window.addEventListener("pagehide", kick);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") kick(); });
    // Anything still only on this register (offline, server busy) is tried again every 30 seconds.
    window.setInterval(() => {
      if (unsyncedTipDrafts(tipDraftStore.get().drafts).some(([, draft]) => !draft.error)) kick();
    }, 30_000);
  }
  if (unsyncedTipDrafts(tipDraftStore.get().drafts).length) scheduleSync();
}

/** A box was typed in. */
export function setTipDraft(orderId: string, raw: string, cents: number, screen: TipScreen) {
  loadTipDrafts();
  setDrafts((drafts) => (drafts[orderId]?.raw === raw ? drafts : editTipDraft(drafts, orderId, raw, cents, screen)));
  scheduleSync();
}

function scheduleSync() {
  if (typeof window === "undefined") return;
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => { timer = null; void syncTipDrafts(); }, SYNC_DELAY_MS);
}

/** Send what is only on this register. Safe to call any time; never throws. */
export async function syncTipDrafts(): Promise<void> {
  if (typeof window === "undefined") return;
  loadTipDrafts();
  if (syncing) { scheduleSync(); return; }
  const pending = unsyncedTipDrafts(tipDraftStore.get().drafts);
  if (!pending.length) return;
  syncing = true;
  tipDraftStore.set({ ...tipDraftStore.get(), syncing: true });
  const sent: Record<string, string> = {};
  for (const [orderId, draft] of pending) sent[orderId] = draft.updatedAt;
  try {
    let response: Response;
    try {
      response = await fetch("/api/pos/tip-drafts", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", keepalive: true,
        body: JSON.stringify({
          drafts: pending.map(([orderId, draft]) => ({
            order_id: orderId, tip_cents: draft.cents, raw: draft.raw.slice(0, 20), screen: draft.screen,
            client_updated_at: draft.updatedAt, device_id: getDeviceId(), terminal: getTerminalLabel(),
          })),
        }),
        signal: AbortSignal.timeout(12_000),
      });
    } catch (error) {
      // No answer: kept on the register, sent when the server is back.
      if (isNoAnswer(error)) reportNetworkFailure();
      tipDraftStore.set({ ...tipDraftStore.get(), lastError: "" });
      return;
    }
    reportServerOk();
    const body: unknown = await response.json().catch(() => null);
    if (response.status >= 500) {
      // The server is having trouble: kept on the register, tried again shortly.
      logDevice("tips.save_retry", "", { status: response.status, count: pending.length });
      return;
    }
    if (!response.ok) {
      const reason = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "The tips could not be saved to the server.";
      logDevice("tips.save_failed", reason, { status: response.status, count: pending.length });
      // A refusal is shown on each tip it concerns; the value stays on this register.
      setDrafts((drafts) => {
        const out = { ...drafts };
        for (const [orderId] of pending) if (out[orderId] && out[orderId]!.updatedAt === sent[orderId]) out[orderId] = { ...out[orderId]!, error: reason };
        return out;
      });
      tipDraftStore.set({ ...tipDraftStore.get(), lastError: reason });
      return;
    }
    const rows = serverTipDraftSchema.array().safeParse(body);
    if (!rows.success) {
      tipDraftStore.set({ ...tipDraftStore.get(), lastError: "The server's answer could not be read. The tips are still on this register." });
      return;
    }
    setDrafts((drafts) => applySaveResult(drafts, sent, rows.data));
    tipDraftStore.set({ ...tipDraftStore.get(), lastError: "" });
  } finally {
    syncing = false;
    tipDraftStore.set({ ...tipDraftStore.get(), syncing: false });
    // Typed again while sending: send that too.
    if (unsyncedTipDrafts(tipDraftStore.get().drafts).some(([orderId, draft]) => draft.updatedAt !== sent[orderId] && !draft.error)) scheduleSync();
  }
}

/**
 * Read the server's copy (orders still waiting for a tip) and merge it in.
 * Called with the screens' own refresh; offline it leaves everything as is.
 */
export async function refreshTipDrafts(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  loadTipDrafts();
  try {
    const response = await fetch("/api/pos/tip-drafts", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return false;
    const rows = serverTipDraftSchema.array().safeParse(await response.json().catch(() => null));
    if (!rows.success) return false;
    // An answer that crossed a save in flight is merged after it, never instead of it.
    setDrafts((drafts) => mergeServerTipDrafts(drafts, rows.data));
    if (unsyncedTipDrafts(tipDraftStore.get().drafts).length) scheduleSync();
    return true;
  } catch (error) {
    if (isNoAnswer(error)) reportNetworkFailure();
    return false;
  }
}

/** Charge / Cash out went through for these orders: their boxes are done. */
export function clearTipDrafts(orderIds: string[]) {
  if (!orderIds.length) return;
  loadTipDrafts();
  setDrafts((drafts) => removeTipDrafts(drafts, orderIds));
}

export function useTipDrafts() {
  return useStore(tipDraftStore, (state) => state, initial);
}
