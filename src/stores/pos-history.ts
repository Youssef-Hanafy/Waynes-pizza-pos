import type { PosDraft } from "@/lib/orders/drafts";
import { createStore, useStore } from "./create-store";

/**
 * Back / Forward for the whole POS (owner, 2026-10-29: "a small arrow back and
 * forward … no matter what, you can go backwards and forwards, like an undo
 * button and a redo button" — e.g. the customer asked for delivery, then
 * switched to pickup).
 *
 * A step is where the register was: the screen, and on New Order the ticket
 * as it stood (order type, customer, address, items, discount …).  Back goes
 * to the step before; Forward re-does what Back undid; doing anything new
 * after going back drops the Forward steps, like any undo / redo.
 *
 * What is never put back from a step: the ticket's own identity and send
 * state (its id, its idempotency key, whether it is sending or was taken
 * offline) and its phone-call link.  So Back can never re-send an order, never
 * revive an order that was sent, and never re-open a phone line.
 */

export const NOT_RESTORED = ["id", "idempotencyKey", "createdAt", "updatedAt", "held", "syncedVersion", "syncedAt", "submitPending", "offline", "phoneCallKey", "phoneCallId"] as const;
export type TicketSnapshot = Omit<PosDraft, (typeof NOT_RESTORED)[number]>;

export type HistoryStep = {
  section: string;
  /** The ticket on screen (New Order only). */
  draftId: string | null;
  ticket: TicketSnapshot | null;
  /** Identifies the step; two equal signatures are the same step. */
  sig: string;
};

export type HistoryState = {
  back: HistoryStep[];
  current: HistoryStep | null;
  forward: HistoryStep[];
  /** Goes up on every Back / Forward, so screens that keep their own state re-read the ticket. */
  restores: number;
};

export const HISTORY_LIMIT = 40;

export function ticketSnapshot(draft: PosDraft): TicketSnapshot {
  const copy: Record<string, unknown> = { ...draft };
  for (const key of NOT_RESTORED) delete copy[key];
  return copy as TicketSnapshot;
}

export function makeStep(section: string, draft: PosDraft | null): HistoryStep {
  const ticket = section === "order" && draft ? ticketSnapshot(draft) : null;
  return { section, draftId: ticket && draft ? draft.id : null, ticket, sig: `${section}|${ticket ? JSON.stringify(ticket) : ""}` };
}

/** Record where the register is now. The same place twice is one step; a new step drops Forward. */
export function pushStep(state: HistoryState, step: HistoryStep, limit = HISTORY_LIMIT): HistoryState {
  if (!state.current) return { ...state, current: step };
  if (state.current.sig === step.sig && state.current.draftId === step.draftId) return state;
  return { ...state, back: [...state.back, state.current].slice(-limit), current: step, forward: [] };
}

export function stepBack(state: HistoryState): { state: HistoryState; target: HistoryStep } | null {
  const target = state.back.at(-1);
  if (!target || !state.current) return null;
  return { target, state: { back: state.back.slice(0, -1), current: target, forward: [state.current, ...state.forward], restores: state.restores + 1 } };
}

export function stepForward(state: HistoryState): { state: HistoryState; target: HistoryStep } | null {
  const target = state.forward[0];
  if (!target || !state.current) return null;
  return { target, state: { back: [...state.back, state.current].slice(-HISTORY_LIMIT), current: target, forward: state.forward.slice(1), restores: state.restores + 1 } };
}

/** A ticket brought back under a new id (after it was closed out): every step that pointed at it follows it. */
export function remapDraft(state: HistoryState, from: string, to: string): HistoryState {
  const move = (step: HistoryStep): HistoryStep => (step.draftId === from ? { ...step, draftId: to } : step);
  return { ...state, back: state.back.map(move), current: state.current ? move(state.current) : null, forward: state.forward.map(move) };
}

/** What a step will put back, in words (the arrows' labels). */
export function describeStep(step: HistoryStep | undefined, sectionLabel: (section: string) => string): string {
  if (!step) return "";
  if (step.section !== "order" || !step.ticket) return sectionLabel(step.section);
  const ticket = step.ticket;
  if (!ticket.started) {
    const kind = ticket.orderKind === "walkin" ? "Walk-in" : ticket.orderKind === "pickup" ? "Pickup" : ticket.orderKind === "delivery" ? "Delivery" : "";
    return `New order details${kind ? ` · ${kind}` : ""}`;
  }
  const items = ticket.cart.reduce((sum, line) => sum + line.quantity, 0);
  const kind = ticket.fulfillment === "delivery" ? "Delivery" : ticket.orderKind === "walkin" ? "Walk-in" : "Pickup";
  return `${kind} ticket · ${items} item${items === 1 ? "" : "s"}`;
}

/*
 * Tickets this register closed out without sending (left New Order, Clear,
 * a new order).  Only these — never sent, never on another register — can be
 * put back by Back / Forward once they are gone from the screen.  A ticket
 * that was sent, sent from another register or taken over there is never
 * brought back.
 */
const closedUnsent = new Set<string>();
export function noteClosedUnsent(ids: readonly string[]) {
  for (const id of ids) closedUnsent.add(id);
  if (closedUnsent.size > 200) for (const id of [...closedUnsent].slice(0, closedUnsent.size - 200)) closedUnsent.delete(id);
}
export function wasClosedUnsent(id: string | null) {
  return Boolean(id && closedUnsent.has(id));
}
export function forgetClosedUnsent(id: string) {
  closedUnsent.delete(id);
}

/** The order Back took back from its payment screen (cancelled on the server), so that screen closes. */
export const takenBack: { orderId: string | null } = { orderId: null };

const initial: HistoryState = { back: [], current: null, forward: [], restores: 0 };
export const historyStore = createStore<HistoryState>(initial);

export function useHistoryState() {
  return useStore(historyStore, (state) => state, initial);
}

/** Goes up on every Back / Forward. */
export function useHistoryRestores() {
  return useStore(historyStore, (state) => state.restores, initial);
}
