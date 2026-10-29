"use client";

import { useEffect, useRef } from "react";
import { activeDraft, blankDraft, draftHasContent, isDraftIdle, type PosDraft } from "@/lib/orders/drafts";
import { logDevice } from "@/lib/pos/device-log";
import { notify, syncStore } from "@/stores/draft-sync";
import { orderActions, orderStore, paymentPromptStore } from "@/stores/order-store";
import { forgetClosedUnsent, historyStore, takenBack, makeStep, pushStep, remapDraft, stepBack, stepForward, wasClosedUnsent, type HistoryStep, type TicketSnapshot } from "@/stores/pos-history";
import { stripeReaderStore } from "@/stores/stripe-reader";
import { lastClosedStore, unsettledOrder } from "@/stores/ticket-closeout";

/** Typing settles into one step (a name is one step, not one per letter). */
const SETTLE_MS = 700;

/**
 * Back / Forward across the whole POS (owner, 2026-10-29).  Records a step
 * whenever the screen changes, and — on New Order — whenever the ticket
 * settles after a change (order type, customer, address, items, discount).
 * See src/stores/pos-history.ts for what a step is and what is never put back.
 *
 * Must be called before the effect that closes out a ticket when New Order is
 * left, so the ticket's last state is recorded before it is closed out.
 */
export function usePosHistory<S extends string>(section: S, setSection: (next: S) => void) {
  const shown = useRef<S>(section);
  const restoring = useRef(false);
  const settle = useRef<number | null>(null);
  const busy = useRef(false);
  /** The ticket as of the last change, so a ticket that goes away (sent, closed) is recorded as it last was. */
  const lastSeen = useRef<HistoryStep | null>(null);

  function record(step: HistoryStep) {
    if (restoring.current) return;
    historyStore.set((state) => pushStep(state, step));
  }

  /** Record where the register is right now (typing still settling included). */
  function commit() {
    if (settle.current !== null) { window.clearTimeout(settle.current); settle.current = null; }
    const step = makeStep(shown.current, activeDraft(orderStore.get()));
    lastSeen.current = step;
    record(step);
  }

  // A new screen: the last state of the old one first (typing still settling), then the new one.
  useEffect(() => {
    if (shown.current !== section) {
      if (settle.current !== null) { window.clearTimeout(settle.current); settle.current = null; if (lastSeen.current) record(lastSeen.current); }
      shown.current = section;
    }
    commit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commit reads refs and stores only
  }, [section]);

  // Ticket changes on New Order: a tap (order type, item, customer, address …) is a step at once;
  // typing settles into one step.  A ticket that goes away is recorded as it last was first.
  useEffect(() => orderStore.subscribe(() => {
    if (restoring.current || shown.current !== "order") return;
    const step = makeStep(shown.current, activeDraft(orderStore.get()));
    const previous = lastSeen.current;
    lastSeen.current = step;
    if (previous && previous.draftId !== step.draftId) {
      if (settle.current !== null) { window.clearTimeout(settle.current); settle.current = null; }
      // An empty ticket that is replaced (the saved ticket loading, a new order over a blank one) is not a step of its own.
      if (previous.ticket && isDraftIdle({ ...blankDraft(), ...previous.ticket }) && historyStore.get().current?.draftId === previous.draftId) {
        if (!restoring.current) historyStore.set((state) => ({ ...state, current: step }));
        return;
      }
      record(previous);
      record(step);
      return;
    }
    if (settle.current !== null) { window.clearTimeout(settle.current); settle.current = null; }
    if (!previous || tappedChange(previous, step)) { record(step); return; }
    settle.current = window.setTimeout(commit, SETTLE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- record/commit read refs and stores only
  }), []);

  useEffect(() => () => { if (settle.current !== null) window.clearTimeout(settle.current); }, []);

  /** Put a step's ticket back on the screen. "revive" = the ticket was just taken back from the payment screen. */
  function putBack(step: HistoryStep, revive: boolean) {
    if (step.section !== shown.current) setSection(step.section as S);
    if (step.section !== "order" || !step.ticket) return;
    const state = orderStore.get();
    const draft = step.draftId ? state.drafts.find((candidate) => candidate.id === step.draftId) : undefined;
    if (!draft) {
      // Gone from the screen.  Put back only a ticket that was never sent: one this register
      // closed out (left New Order, Clear), or the one just taken back from the payment screen.
      if (revive || wasClosedUnsent(step.draftId)) {
        if (step.draftId && lastClosedStore.get()?.draft.id === step.draftId) lastClosedStore.set(null);
        if (step.draftId) forgetClosedUnsent(step.draftId);
        const fresh = reviveTicket(step.ticket);
        historyStore.set((current) => remapDraft(current, step.draftId ?? "", fresh));
        return;
      }
      // Sent (here or on another register) or taken over: Back never brings it back.
      if (!isDraftIdle({ ...blankDraft(), ...step.ticket })) notify("That ticket was already sent — open it from Today's Orders to change it.", "warn");
      return;
    }
    if (draft.submitPending || draft.offline) {
      notify("That ticket is sending — it can't be changed from here.", "warn");
      return;
    }
    if (state.activeId !== draft.id) orderActions.resume(draft.id);
    orderActions.update(step.ticket);
  }

  async function go(direction: "back" | "forward") {
    if (busy.current) return;
    if (stripeReaderStore.get().status.state === "collecting") { notify("A card is being taken — finish or cancel it first.", "warn"); return; }
    if (syncStore.get().sending.length) { notify("The order is sending — one moment.", "warn"); return; }
    commit();
    const moved = direction === "back" ? stepBack(historyStore.get()) : stepForward(historyStore.get());
    if (!moved) return;
    let revive = false;
    if (paymentPromptStore.get()) {
      // On the payment screen of an order just sent, Back takes the ticket back to change it:
      // the order is closed out exactly as leaving the screen does (cancelled only if nothing
      // was paid or printed for it), and only once the server confirms is the ticket put back.
      const orderId = unsettledOrder.id;
      if (direction !== "back" || !orderId) { notify("Finish this payment, or tap Pay later, first.", "warn"); return; }
      busy.current = true;
      try {
        const response = await fetch(`/api/pos/orders/${orderId}/abandon`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10_000) });
        const body = (await response.json().catch(() => null)) as { cancelled?: boolean } | null;
        if (!response.ok || !body?.cancelled) { notify("That order already has a payment or a printed slip, so it stays — open it from Today's Orders to change it.", "warn"); return; }
        unsettledOrder.id = null;
        takenBack.orderId = orderId;
        revive = true;
        logDevice("pos.history_back_from_payment", "", { order_id: orderId });
      } catch {
        notify("No answer from the server — try Back again in a moment.", "warn");
        return;
      } finally {
        busy.current = false;
      }
    }
    restoring.current = true;
    historyStore.set(moved.state);
    putBack(moved.target, revive);
    // Once the screen has changed, this is where the register is.
    window.setTimeout(() => {
      restoring.current = false;
      if (settle.current !== null) { window.clearTimeout(settle.current); settle.current = null; }
      const here = makeStep(shown.current, activeDraft(orderStore.get()));
      lastSeen.current = here;
      historyStore.set((state) => ({ ...state, current: here }));
    }, 200);
  }

  return { back: () => void go("back"), forward: () => void go("forward") };
}

/** A change made with a tap rather than typing: recorded as its own step straight away. */
function tappedChange(before: HistoryStep, after: HistoryStep) {
  const a = before.ticket;
  const b = after.ticket;
  if (!a || !b) return true;
  return a.started !== b.started || a.orderKind !== b.orderKind || a.fulfillment !== b.fulfillment || a.source !== b.source
    || a.isTest !== b.isTest || a.addressId !== b.addressId || a.manualType !== b.manualType || a.presetDiscountId !== b.presetDiscountId
    || (a.customer?.id ?? null) !== (b.customer?.id ?? null)
    || JSON.stringify(a.cart) !== JSON.stringify(b.cart) || JSON.stringify(a.addTo) !== JSON.stringify(b.addTo);
}

/** The same ticket again under a new id and key (the order it became was cancelled), on screen. */
function reviveTicket(ticket: TicketSnapshot): string {
  const base = blankDraft();
  const fresh: PosDraft = { ...base, ...ticket, id: base.id, idempotencyKey: base.idempotencyKey, createdAt: base.createdAt, updatedAt: base.updatedAt };
  orderStore.set((state) => {
    const current = activeDraft(state);
    const drafts = state.drafts.filter((candidate) => candidate.id !== current.id || draftHasContent(candidate));
    return { activeId: fresh.id, drafts: [...drafts, fresh] };
  });
  return fresh.id;
}
