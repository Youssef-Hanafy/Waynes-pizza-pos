import { describe, expect, it } from "vitest";
import {
  activeDraft, blankDraft, draftFromCall, draftToOrderPayload, findDraftForCall, heldDrafts, holdActive, initialDrafts, parseSavedDrafts, removeDraft, resumeDraft, startDraft, updateDraft,
} from "./drafts";

const line = { line_id: "l1", menu_item_id: "64000000-0000-4000-8000-000000000001", variant_id: null, quantity: 1, special_instructions: "", modifiers: [] };

describe("ticket drafts (build sheet §13, §36, test 10, test 15)", () => {
  it("holds the ticket on screen and starts a fresh one", () => {
    let state = initialDrafts();
    state = updateDraft(state, state.activeId, { cart: [line], firstName: "Walk" });
    const firstId = state.activeId;
    state = holdActive(state);
    expect(state.activeId).not.toBe(firstId);
    expect(heldDrafts(state).map((draft) => draft.id)).toEqual([firstId]);
    expect(heldDrafts(state)[0]!.cart).toHaveLength(1);
  });

  it("never destroys the first draft when a second call starts an order (§36)", () => {
    let state = initialDrafts();
    state = updateDraft(state, state.activeId, { cart: [line] });
    const lineOne = state.activeId;
    state = startDraft(state, draftFromCall({ callKey: "call-2", callId: null, line: 2, phoneNumber: "7745552222", callerName: "JANE", customer: null, withoutProfile: true }));
    expect(activeDraft(state).phoneLine).toBe(2);
    expect(state.drafts.find((draft) => draft.id === lineOne)!.cart).toHaveLength(1);
    state = resumeDraft(state, lineOne);
    expect(activeDraft(state).id).toBe(lineOne);
    expect(findDraftForCall(state, "call-2")).toBeDefined();
  });

  it("drops an empty ticket instead of cluttering the hold tray", () => {
    const state = holdActive(initialDrafts());
    expect(state.drafts).toHaveLength(1);
  });

  it("survives a refresh, and ignores anything corrupt (test 15)", () => {
    let state = initialDrafts();
    state = updateDraft(state, state.activeId, { cart: [line], orderNote: "Extra napkins" });
    const restored = parseSavedDrafts(JSON.stringify(state));
    expect(restored).toEqual(state);
    expect(parseSavedDrafts("{not json")).toBeNull();
    expect(parseSavedDrafts(JSON.stringify({ activeId: "x", drafts: [{ nope: true }] }))).toBeNull();
  });

  it("always leaves a ticket on screen after one is submitted", () => {
    const state = initialDrafts();
    const next = removeDraft(state, state.activeId);
    expect(next.drafts).toHaveLength(1);
    expect(next.activeId).not.toBe(state.activeId);
  });

  it("carries the call into the order payload: source, line and call id (§11)", () => {
    const draft = blankDraft({ ...draftFromCall({ callKey: "k", callId: "64000000-0000-4000-8000-0000000000cc", line: 1, phoneNumber: "5085551234", callerName: "JOHN SMITH", customer: null }), firstName: "John", lastName: "Smith", cart: [line] });
    const payload = draftToOrderPayload(draft);
    expect(payload).toMatchObject({ source: "phone", phone_line: 1, phone_call_id: "64000000-0000-4000-8000-0000000000cc", phone: "5085551234", customer_mode: "identified", idempotency_key: draft.idempotencyKey });
    // The employee never retyped the number.
    expect(draft.phone).toBe("5085551234");
    // A walk-in never sends a phone line.
    expect(draftToOrderPayload(blankDraft({ cart: [line] }))).toMatchObject({ source: "pos", phone_line: null, phone_call_id: "", phone: "" });
  });

  it("keeps the same idempotency key across retries so a resend cannot duplicate the order (§30)", () => {
    const draft = blankDraft({ cart: [line] });
    expect(draftToOrderPayload(draft).idempotency_key).toBe(draftToOrderPayload({ ...draft }).idempotency_key);
  });
});
