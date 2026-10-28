"use client";

import {
  activeDraft, findDraftForCall, holdActive, initialDrafts, parseSavedDrafts, removeDraft, resumeDraft, startDraft, updateDraft,
  type DraftsState, type PosDraft,
} from "@/lib/orders/drafts";
import { workspaceStorageKey } from "@/lib/tenancy/active-workspace";
import { getClientWorkspaceScope } from "@/lib/tenancy/client-scope";
import { createStore, useStore } from "./create-store";

/**
 * Tickets at this register.  Saved to the device on every change, so a
 * refresh, a crash or a closed tab never loses an order being entered (§30).
 * The key includes the workspace (§37.3): a device shared by two businesses
 * can never open one business's tickets in the other.
 */
const LEGACY_STORAGE_KEY = "wayne.pos.drafts.v1";
// v2 (2026-10-11): a tab still running an older copy of the POS kept writing
// its own idea of the tickets to v1, and the two tabs fought over it (the
// screen flipped between the menu and the New Order card).  A new key means
// an old tab can never touch the tickets of this one.
let STORAGE_KEY = workspaceStorageKey(null, "pos-drafts.v2");
const PREVIOUS_KEY_NAME = "pos-drafts.v1";

const serverSnapshot = initialDrafts();
export const orderStore = createStore<DraftsState>(serverSnapshot);

let loaded = false;

function save(state: DraftsState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or a full disk: keep working in memory.
  }
}

/** Restore saved tickets once, in the browser. */
export function loadSavedDrafts() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  const scope = getClientWorkspaceScope();
  STORAGE_KEY = workspaceStorageKey(scope.workspaceId, "pos-drafts.v2");
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
    // Tickets saved under the old key are carried over once.
    if (raw === null) raw = window.localStorage.getItem(workspaceStorageKey(scope.workspaceId, PREVIOUS_KEY_NAME));
    // One-time move of tickets saved before workspaces existed.  They can only
    // belong to the workspace the pre-platform POS served.
    if (raw === null && scope.workspaceId && scope.legacyOperations) {
      raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw !== null) {
        window.localStorage.setItem(STORAGE_KEY, raw);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    }
  } catch {
    raw = null;
  }
  const saved = parseSavedDrafts(raw);
  backUpUnreadable(raw, saved?.drafts.length ?? 0);
  if (saved) orderStore.set(saved);
  orderStore.subscribe(() => save(orderStore.get()));
  // No cross-tab mirroring: only one tab runs the POS (see app/pos/one-tab.tsx).
  // Two tabs mirroring each other's tickets is what made the screen shake.
}

/**
 * Tickets saved by a different build that this one can't read are copied aside
 * before anything is written over them (owner, 2026-10-28: an old and a new copy
 * of the POS must never be able to wipe each other's tickets).  Nothing reads the
 * copy automatically; it is there to recover by hand.
 */
function backUpUnreadable(raw: string | null, readable: number) {
  if (!raw) return;
  try {
    const value = JSON.parse(raw) as { drafts?: unknown };
    const total = Array.isArray(value?.drafts) ? value.drafts.length : 0;
    if (total <= readable) return;
    window.localStorage.setItem(`${STORAGE_KEY}.unreadable`, JSON.stringify({ at: new Date().toISOString(), build: process.env.WAYNE_BUILD_ID ?? "", raw }));
    console.warn(`POS: ${total - readable} saved ticket(s) could not be read by this build; a copy was kept.`);
  } catch {
    // Not JSON at all: nothing to keep.
  }
}

export const orderActions = {
  update(patch: Partial<PosDraft> | ((draft: PosDraft) => Partial<PosDraft>)) {
    orderStore.set((state) => updateDraft(state, state.activeId, patch));
  },
  hold() {
    orderStore.set((state) => holdActive(state));
  },
  resume(id: string) {
    orderStore.set((state) => resumeDraft(state, id));
  },
  /** Start a ticket, keeping the one on screen on hold (§36: never destroy a draft). */
  start(patch: Partial<PosDraft>) {
    orderStore.set((state) => startDraft(state, patch));
  },
  /** Resume the ticket already started from this call, or start one (§32). */
  startOrResumeForCall(callKey: string, patch: Partial<PosDraft>) {
    const existing = findDraftForCall(orderStore.get(), callKey);
    if (existing) {
      orderStore.set((state) => updateDraft(resumeDraft(state, existing.id), existing.id, (draft) => ({ phoneCallId: patch.phoneCallId ?? draft.phoneCallId })));
      return existing.id;
    }
    orderStore.set((state) => startDraft(state, patch));
    return orderStore.get().activeId;
  },
  remove(id: string) {
    orderStore.set((state) => removeDraft(state, id));
  },
  /**
   * Add items to an order already sent (Today's Orders → Add items, owner
   * 2026-10-13): a ticket that holds only the new items; the one on screen is
   * kept on hold.  An Add-items ticket already open for this order is resumed.
   */
  addToOrder(order: { id: string; order_number: string; daily_number: number | null; customer_name: string; fulfillment_type: string; paid: boolean }) {
    const existing = orderStore.get().drafts.find((draft) => draft.addTo?.orderId === order.id);
    if (existing) { orderStore.set((state) => resumeDraft(state, existing.id)); return; }
    orderStore.set((state) => startDraft(state, {
      started: true, source: "pos", customerMode: "walk_in", fulfillment: order.fulfillment_type === "delivery" ? "delivery" : "pickup",
      firstName: order.customer_name,
      addTo: {
        orderId: order.id, orderNumber: order.order_number, dailyNumber: order.daily_number, customerName: order.customer_name,
        fulfillment: order.fulfillment_type === "delivery" ? "delivery" : "pickup", paid: order.paid,
        editing: false, existing: [], removed: [], quantities: {}, discountCents: 0,
      },
    }));
  },
  /**
   * Edit an order already sent (owner, 2026-10-24: tap the order card): its
   * original lines on the ticket, to change, take off or add to.  Opened fresh
   * every time, so it always shows the order as it is now.
   */
  editOrder(order: { id: string; order_number: string; daily_number: number | null; customer_name: string; fulfillment_type: string; paid: boolean; discount_cents: number },
    existing: NonNullable<PosDraft["addTo"]>["existing"]) {
    orderStore.set((state) => {
      const stale = state.drafts.find((draft) => draft.addTo?.orderId === order.id);
      const base = stale ? removeDraft(state, stale.id) : state;
      return startDraft(base, {
        started: true, source: "pos", customerMode: "walk_in", fulfillment: order.fulfillment_type === "delivery" ? "delivery" : "pickup",
        firstName: order.customer_name,
        addTo: {
          orderId: order.id, orderNumber: order.order_number, dailyNumber: order.daily_number, customerName: order.customer_name,
          fulfillment: order.fulfillment_type === "delivery" ? "delivery" : "pickup", paid: order.paid,
          editing: true, existing, removed: [], quantities: {}, discountCents: order.discount_cents,
        },
      });
    });
  },
  /** Clear the ticket on screen back to a blank walk-in. */
  clearActive() {
    orderStore.set((state) => removeDraft(state, state.activeId));
  },
};

export function useActiveDraft() {
  return useStore(orderStore, (state) => activeDraft(state), serverSnapshot);
}

export function useDrafts() {
  return useStore(orderStore, (state) => state, serverSnapshot);
}

/**
 * True while the payment prompt is on screen after sending an order, so a
 * ringing phone never pulls the cashier away mid-payment (§34.1).
 */
export const paymentPromptStore = createStore<boolean>(false);
