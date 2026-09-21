"use client";

import { z } from "zod";
import {
  activeDraft, adoptDraft, draftBody, draftLabel, draftNeedsSync, draftToOrderPayload, markSynced, posDraftSchema, removeDraft, updateDraft,
  type PosDraft,
} from "@/lib/orders/drafts";
import { posOrderCreatedSchema } from "@/lib/pos/schemas";
import { createStore, useStore } from "./create-store";
import { orderStore } from "./order-store";
import { getTerminalLabel, phoneActions } from "./phone-store";

/**
 * Phase 6 — tickets that survive the register (build sheet §22, §30, §36).
 *
 *   * Every ticket with something on it is mirrored to the server a moment
 *     after it changes, so another register can see a held ticket and take it
 *     over, and a register that dies does not take its tickets with it.
 *   * A submit that fails for lack of a connection is kept and resent with the
 *     same idempotency key when the connection returns — exactly one order.
 *   * Nothing here ever reports an order as sent until the server says so.
 */

const DEVICE_KEY = "wayne.pos.device";
const SYNC_DELAY_MS = 1500;

export const remoteDraftSchema = z.object({
  id: z.uuid(),
  idempotency_key: z.string(),
  device_id: z.string(),
  terminal: z.string(),
  owner_name: z.string().nullable(),
  status: z.enum(["open", "held", "submitted", "discarded"]),
  label: z.string(),
  item_count: z.number().int(),
  phone_line: z.number().int().nullable(),
  phone_call_id: z.uuid().nullable(),
  version: z.number().int(),
  order_id: z.uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type RemoteDraft = z.infer<typeof remoteDraftSchema>;

export const draftSyncResultSchema = z.object({
  ok: z.boolean(),
  reason: z.enum(["taken", "closed"]).optional(),
  draft: remoteDraftSchema.nullable(),
});

type SyncState = {
  /** Tickets in progress on the other registers. */
  remote: RemoteDraft[];
  /** Short messages for the cashier ("Order W000123 sent after the connection came back"). */
  notices: { id: number; text: string; tone: "ok" | "warn" }[];
  sending: string[];
};

const serverSnapshot: SyncState = { remote: [], notices: [], sending: [] };
export const syncStore = createStore<SyncState>(serverSnapshot);

let noticeId = 0;
export function notify(text: string, tone: "ok" | "warn" = "ok") {
  noticeId += 1;
  const id = noticeId;
  syncStore.set((state) => ({ ...state, notices: [...state.notices.slice(-3), { id, text, tone }] }));
  window.setTimeout(() => dismissNotice(id), tone === "warn" ? 20_000 : 8_000);
}
export function dismissNotice(id: number) {
  syncStore.set((state) => ({ ...state, notices: state.notices.filter((notice) => notice.id !== id) }));
}

/** A stable id for this register (browser), separate from who is signed in. */
export function getDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_KEY);
    if (existing && existing.length >= 8) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY, created);
    return created;
  } catch {
    return "register-without-storage";
  }
}

async function post(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000),
  });
  const data: unknown = await response.json().catch(() => null);
  return { response, data };
}

function isOffline(error: unknown) {
  return error instanceof TypeError || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) || (typeof navigator !== "undefined" && !navigator.onLine);
}

function dropLocal(id: string) {
  orderStore.set((state) => (state.drafts.some((draft) => draft.id === id) ? removeDraft(state, id) : state));
}

let timer: number | null = null;
let syncing = false;

export const draftSync = {
  /** Save changed tickets shortly after the cashier stops typing. */
  schedule() {
    if (typeof window === "undefined") return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => { timer = null; void draftSync.pushNow(); }, SYNC_DELAY_MS);
  },

  async pushNow() {
    if (syncing) { draftSync.schedule(); return; }
    syncing = true;
    try {
      const state = orderStore.get();
      for (const draft of state.drafts.filter(draftNeedsSync)) {
        if (draft.submitPending) continue;
        const savedAt = new Date().toISOString();
        try {
          const { response, data } = await post("/api/pos/drafts", {
            id: draft.id, idempotency_key: draft.idempotencyKey, device_id: getDeviceId(), terminal: getTerminalLabel(),
            status: draft.id === state.activeId ? "open" : "held", label: draftLabel(draft), item_count: draft.cart.length,
            phone_line: draft.phoneLine, phone_call_id: draft.phoneCallId ?? "", payload: draftBody(draft),
          });
          const parsed = draftSyncResultSchema.safeParse(data);
          if (!response.ok || !parsed.success) continue;
          if (parsed.data.ok && parsed.data.draft) {
            orderStore.set((current) => markSynced(current, draft.id, parsed.data.draft!.version, savedAt));
          } else if (parsed.data.reason === "taken") {
            dropLocal(draft.id);
            notify(`${draftLabel(draft)} is now on ${parsed.data.draft?.terminal || "another register"}. It was taken over there.`, "warn");
          } else if (parsed.data.reason === "closed") {
            dropLocal(draft.id);
            if (parsed.data.draft?.status === "submitted") notify(`${draftLabel(draft)} was already sent.`);
          }
        } catch {
          return; // Offline: everything stays local and is saved when the connection returns.
        }
      }
    } finally {
      syncing = false;
    }
  },

  /** What is open on the other registers. */
  async refreshRemote() {
    try {
      const response = await fetch("/api/pos/drafts", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const parsed = remoteDraftSchema.array().safeParse(await response.json());
      if (!response.ok || !parsed.success) return;
      const device = getDeviceId();
      const localIds = new Set(orderStore.get().drafts.map((draft) => draft.id));
      // A ticket this register holds that the server now shows on another one was taken over.
      for (const remote of parsed.data) {
        if (localIds.has(remote.id) && remote.device_id !== device) {
          const local = orderStore.get().drafts.find((draft) => draft.id === remote.id);
          dropLocal(remote.id);
          if (local) notify(`${draftLabel(local)} was taken over by ${remote.terminal || "another register"}.`, "warn");
        }
      }
      syncStore.set((state) => ({ ...state, remote: parsed.data.filter((remote) => remote.device_id !== device) }));
    } catch {
      // Offline: keep the last list.
    }
  },

  /** Take a ticket from another register and put it on screen here. */
  async takeOver(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const { response, data } = await post(`/api/pos/drafts/${id}/take`, { device_id: getDeviceId(), terminal: getTerminalLabel() });
      const parsed = draftSyncResultSchema.safeParse(data);
      if (!response.ok || !parsed.success || !parsed.data.draft) {
        return { ok: false, message: data && typeof data === "object" && "error" in data ? String(data.error) : "That ticket could not be moved here." };
      }
      if (!parsed.data.ok) return { ok: false, message: "That ticket was already sent or cleared." };
      const body = posDraftSchema.safeParse({ ...parsed.data.draft.payload, syncedVersion: parsed.data.draft.version, syncedAt: new Date().toISOString(), submitPending: false });
      if (!body.success) return { ok: false, message: "That ticket could not be read on this register." };
      orderStore.set((state) => adoptDraft(state, body.data, body.data.syncedAt ?? undefined));
      // Saved again straight away so the server records this register as the holder.
      orderStore.set((state) => markSynced(state, body.data.id, parsed.data.draft!.version, new Date().toISOString()));
      syncStore.set((state) => ({ ...state, remote: state.remote.filter((remote) => remote.id !== id) }));
      return { ok: true };
    } catch (error) {
      return { ok: false, message: isOffline(error) ? "No connection. Try again when it is back." : "That ticket could not be moved here." };
    }
  },

  /** Tell the server a ticket was cleared on purpose. */
  async discard(draft: PosDraft) {
    if (draft.syncedVersion === null) return;
    try { await post(`/api/pos/drafts/${draft.id}/close`, { device_id: getDeviceId(), outcome: "discarded" }); } catch { /* the server list expires it after a day */ }
  },

  /**
   * Send a ticket.  Only a server answer counts as sent (§30); a dropped
   * connection keeps the ticket, marks it pending, and it is resent with the
   * same idempotency key when the connection returns.
   */
  async submit(id: string): Promise<{ ok: true; order: z.infer<typeof posOrderCreatedSchema> } | { ok: false; message: string; pending: boolean }> {
    const draft = orderStore.get().drafts.find((candidate) => candidate.id === id);
    if (!draft) return { ok: false, message: "That ticket is no longer on this register.", pending: false };
    if (syncStore.get().sending.includes(id)) return { ok: false, message: "Already sending…", pending: false };
    syncStore.set((state) => ({ ...state, sending: [...state.sending, id] }));
    try {
      const { response, data } = await post("/api/pos/orders", draftToOrderPayload(draft));
      const parsed = posOrderCreatedSchema.safeParse(data);
      if (!response.ok || !parsed.success) {
        // A server answer that is not a success is a real refusal (sold out,
        // bad address…): the cashier fixes it; it is not queued.
        orderStore.set((state) => updateDraft(state, id, { submitPending: false }));
        return { ok: false, pending: false, message: data && typeof data === "object" && "error" in data ? String(data.error) : "The ticket could not be submitted." };
      }
      if (draft.phoneCallKey) phoneActions.clearCompletedCall(draft.phoneCallKey);
      dropLocal(id);
      void post(`/api/pos/drafts/${id}/close`, { device_id: getDeviceId(), outcome: "submitted" }).catch(() => undefined);
      return { ok: true, order: parsed.data };
    } catch (error) {
      if (!isOffline(error)) return { ok: false, pending: false, message: error instanceof Error ? error.message : "The ticket could not be submitted." };
      orderStore.set((state) => updateDraft(state, id, { submitPending: true }));
      return { ok: false, pending: true, message: "Not sent — no connection. The ticket is saved and will send by itself when the connection is back." };
    } finally {
      syncStore.set((state) => ({ ...state, sending: state.sending.filter((candidate) => candidate !== id) }));
    }
  },

  /** Resend every ticket that failed for lack of a connection (§30: retry failed cloud writes). */
  async retryPending() {
    for (const draft of orderStore.get().drafts.filter((candidate) => candidate.submitPending)) {
      const result = await draftSync.submit(draft.id);
      if (result.ok) notify(`Order ${result.order.order_number} sent now that the connection is back${result.order.duplicate ? " (it had already gone through)" : ""}.`);
      else if (!result.pending) notify(`${draftLabel(draft)} could not be sent: ${result.message}`, "warn");
      else return; // Still offline.
    }
  },

  pendingCount() {
    return orderStore.get().drafts.filter((draft) => draft.submitPending).length;
  },

  activeId() {
    return activeDraft(orderStore.get()).id;
  },
};

export function useSyncState() {
  return useStore(syncStore, (state) => state, serverSnapshot);
}
