import { describe, expect, it } from "vitest";
import { blankDraft } from "@/lib/orders/drafts";
import { describeStep, makeStep, noteClosedUnsent, pushStep, remapDraft, stepBack, stepForward, ticketSnapshot, wasClosedUnsent, type HistoryState } from "./pos-history";

const empty: HistoryState = { back: [], current: null, forward: [], restores: 0 };
const names = (section: string) => ({ order: "New Order", today: "Today's Orders" })[section] ?? section;

describe("Back / Forward on the POS (owner, 2026-10-29)", () => {
  it("goes back to the step before and forward again, like undo / redo", () => {
    const draft = blankDraft();
    const delivery = { ...draft, orderKind: "delivery" as const, fulfillment: "delivery" as const };
    const started = { ...delivery, started: true, address: { ...delivery.address, address1: "12 Main St" } };
    let state = empty;
    for (const step of [makeStep("order", draft), makeStep("order", delivery), makeStep("order", started)]) state = pushStep(state, step);
    expect(state.back).toHaveLength(2);

    // Delivery, then the customer wants pickup: Back to the order details with Delivery picked.
    const back = stepBack(state)!;
    expect(back.target.ticket?.orderKind).toBe("delivery");
    expect(back.target.ticket?.started).toBe(false);
    expect(describeStep(back.target, names)).toBe("New order details · Delivery");
    expect(back.state.restores).toBe(1);

    // Forward re-does it.
    const forward = stepForward(back.state)!;
    expect(forward.target.ticket?.started).toBe(true);
    expect(forward.state.forward).toHaveLength(0);
    expect(stepForward(forward.state)).toBeNull();
  });

  it("drops Forward once something new is done after going back, and keeps one step per place", () => {
    const draft = blankDraft();
    let state = pushStep(pushStep(empty, makeStep("order", draft)), makeStep("today", draft));
    state = stepBack(state)!.state;
    expect(state.forward).toHaveLength(1);
    state = pushStep(state, makeStep("customers", draft));
    expect(state.forward).toHaveLength(0);
    expect(pushStep(state, makeStep("customers", draft))).toBe(state);
    expect(stepBack(empty)).toBeNull();
  });

  it("never puts back a ticket's identity, send state or phone line", () => {
    const draft = blankDraft({ submitPending: true, phoneCallKey: "call-1", phoneCallId: "c1", phoneLine: 1 });
    const snapshot = ticketSnapshot(draft) as Record<string, unknown>;
    for (const key of ["id", "idempotencyKey", "submitPending", "offline", "phoneCallKey", "phoneCallId", "syncedVersion"]) expect(key in snapshot).toBe(false);
    expect(snapshot.phoneLine).toBe(1);
    // Only New Order steps carry a ticket.
    expect(makeStep("today", draft).ticket).toBeNull();
  });

  it("follows a ticket brought back under a new id, and only brings back tickets closed out unsent here", () => {
    const draft = blankDraft();
    const state = pushStep(pushStep(empty, makeStep("order", draft)), makeStep("today", null));
    const moved = remapDraft(state, draft.id, "new-id");
    expect(moved.back[0]?.draftId).toBe("new-id");
    expect(wasClosedUnsent(draft.id)).toBe(false);
    noteClosedUnsent([draft.id]);
    expect(wasClosedUnsent(draft.id)).toBe(true);
    expect(wasClosedUnsent(null)).toBe(false);
  });

  it("says where each arrow goes", () => {
    const draft = blankDraft({ started: true, orderKind: "pickup", cart: [] });
    expect(describeStep(makeStep("today", null), names)).toBe("Today's Orders");
    expect(describeStep(makeStep("order", draft), names)).toBe("Pickup ticket · 0 items");
    expect(describeStep(undefined, names)).toBe("");
  });
});
