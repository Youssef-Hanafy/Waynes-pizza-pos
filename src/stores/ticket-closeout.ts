"use client";

import { activeDraft, blankDraft, draftHasContent, removeDraft, type PosDraft } from "@/lib/orders/drafts";
import { createStore, useStore } from "./create-store";
import { draftSync } from "./draft-sync";
import { orderStore } from "./order-store";
import { phoneActions, phoneStore } from "./phone-store";
import { ACTIVE_STATUSES } from "@/lib/phone/phone-state";

/**
 * Tickets are never held (owner, 2026-10-19): "the phone line automatically
 * closes out once you press away or take another order if you don't submit
 * it … before it was holding the lines on the POS … and it wouldn't let you
 * pick up the phone."
 *
 * Leaving New Order, or starting another order, closes out a ticket that was
 * not sent: its call is closed so the line is free, and the ticket is dropped.
 * Only a ticket already sent and waiting for the connection is kept (it sends
 * by itself).  The last ticket closed out can be brought back with one tap
 * for a few minutes, in case it was a slip of the finger.
 */
type Closed = { draft: PosDraft; closedAt: number };
export const lastClosedStore = createStore<Closed | null>(null);
const RESTORE_FOR_MS = 10 * 60_000;

function closeCall(draft: PosDraft) {
  if (!draft.phoneCallKey) return;
  const call = phoneStore.get().calls[draft.phoneCallKey];
  // A call already finished on the server (or by another register) is left alone.
  if (call && !ACTIVE_STATUSES.includes(call.status)) return;
  void phoneActions.dismissCall(draft.phoneCallKey);
}

/**
 * Close out every ticket on this register that was not sent.
 * keepActive: leave the ticket on screen alone (used when the POS opens, so a
 * refresh never loses the order being typed) and only drop the old held ones.
 */
export function closeOutUnsentTickets(options: { keepActive?: boolean } = {}) {
  const state = orderStore.get();
  const current = activeDraft(state);
  // An order taken offline is never closed out: it is a real order waiting to be sent (owner, 2026-10-24).
  const closing = state.drafts.filter((draft) => !draft.submitPending && !draft.offline && !(options.keepActive && draft.id === current.id));
  if (!closing.length) return;
  const worthKeeping = closing.find((draft) => draft.id === current.id && draft.cart.length > 0)
    ?? closing.filter((draft) => draft.cart.length > 0).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  if (worthKeeping) {
    const closedAt = Date.now();
    lastClosedStore.set({ draft: worthKeeping, closedAt });
    window.setTimeout(() => { if (lastClosedStore.get()?.closedAt === closedAt) lastClosedStore.set(null); }, RESTORE_FOR_MS);
  }
  for (const draft of closing) {
    if (!draftHasContent(draft)) continue;
    closeCall(draft);
    void draftSync.discard(draft);
  }
  orderStore.set((now) => closing.reduce((next, draft) => removeDraft(next, draft.id), now));
}

/** Bring back the last ticket closed out (a new ticket with the same items and customer). */
export function restoreLastClosed() {
  const closed = lastClosedStore.get();
  if (!closed) return;
  lastClosedStore.set(null);
  const base = blankDraft();
  // A new key: the old ticket was never sent, but this is a new attempt.  Its
  // call was closed with it; the order still remembers the line it came in on.
  const fresh: PosDraft = {
    ...closed.draft, id: base.id, idempotencyKey: base.idempotencyKey, createdAt: base.createdAt, updatedAt: base.updatedAt,
    held: false, syncedVersion: null, syncedAt: null, submitPending: false, phoneCallKey: null, offline: null,
  };
  orderStore.set((state) => {
    const current = activeDraft(state);
    // Bring back only shows over a blank ticket; that blank one goes.
    const drafts = state.drafts.filter((candidate) => candidate.id !== current.id || draftHasContent(candidate));
    return { activeId: fresh.id, drafts: [...drafts, fresh] };
  });
}

export function useLastClosed() {
  return useStore(lastClosedStore, (state) => state?.draft ?? null, null);
}

/**
 * The order just sent from New Order that has no payment and no Pay later yet.
 * Leaving New Order closes it out (the server cancels it if nothing was paid or
 * printed); opening that same order to pay it elsewhere keeps it.
 */
export const unsettledOrder: { id: string | null } = { id: null };

export function keepUnsettledOrder(orderId: string) {
  if (unsettledOrder.id === orderId) unsettledOrder.id = null;
}
