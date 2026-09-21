"use client";

import {
  activeDraft, findDraftForCall, holdActive, initialDrafts, parseSavedDrafts, removeDraft, resumeDraft, startDraft, updateDraft,
  type DraftsState, type PosDraft,
} from "@/lib/orders/drafts";
import { createStore, useStore } from "./create-store";

/**
 * Tickets at this register.  Saved to the device on every change, so a
 * refresh, a crash or a closed tab never loses an order being entered (§30).
 */
const STORAGE_KEY = "wayne.pos.drafts.v1";

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
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  const saved = parseSavedDrafts(raw);
  if (saved) orderStore.set(saved);
  orderStore.subscribe(() => save(orderStore.get()));
  // Another tab on the same device edited the tickets.
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    const next = parseSavedDrafts(event.newValue);
    if (next) orderStore.set(next);
  });
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
