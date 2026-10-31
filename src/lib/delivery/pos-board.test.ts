import { describe, expect, it } from "vitest";
import { cashoutLines, cashoutSummary, maxTipCents, paidByLabel, posDeliveryOrderSchema, repeatedPhoneTips, tipAllowed, tipOnCardCents } from "./pos-board";

const base = { order_number: "W001018", status: "out_for_delivery", payment_status: "unpaid", payment_method: "cash", placed_at: null };
const cash = posDeliveryOrderSchema.parse({ ...base, order_id: "a0000000-0000-4000-8000-000000000001", total_cents: 2300, paid_by: "cash" });
const held = posDeliveryOrderSchema.parse({ ...base, order_id: "a0000000-0000-4000-8000-000000000002", total_cents: 3250, paid_by: "card_held", hold_cents: 4225 });
const charged = posDeliveryOrderSchema.parse({ ...base, order_id: "a0000000-0000-4000-8000-000000000003", total_cents: 1800, tip_cents: 400, paid_by: "card" });

describe("driver cash-out (owner, 2026-10-11)", () => {
  it("driver hands in the cash orders minus the card tips the store owes them", () => {
    const summary = cashoutSummary([cash, held, charged], { [cash.order_id]: 300, [held.order_id]: 500, [charged.order_id]: 400 });
    // The charged card's $4 tip was taken on the phone; the $4 typed at cash-out is ignored.
    expect(summary).toEqual({ cashOrders: 2300, cashTips: 300, cardTips: 900, tips: 1200, handIn: 1400 });
  });

  it("caps a delivery card's tip at what Stripe lets that card be captured for", () => {
    expect(maxTipCents(held)).toBe(975);
    expect(cashoutSummary([held], { [held.order_id]: 5000 }).cardTips).toBe(975);
  });

  it("a card Stripe won't increase takes no tip", () => {
    const fixed = posDeliveryOrderSchema.parse({ ...base, order_id: "a0000000-0000-4000-8000-000000000004", total_cents: 3250, paid_by: "card_held", hold_cents: 3250 });
    expect(maxTipCents(fixed)).toBe(0);
  });

  it("a charged card's tip comes from the order, not the tip box", () => {
    expect(tipAllowed(charged)).toBe(false);
    expect(tipAllowed(held)).toBe(true);
    expect(tipAllowed(cash)).toBe(true);
  });

  it("one cash-out covers a card run and a cash run together, each with its own tip", () => {
    const lines = cashoutLines([held, cash], { [held.order_id]: 600, [cash.order_id]: 400 });
    expect(lines.map(({ tip, collected, storePays, keeps }) => ({ tip, collected, storePays, keeps }))).toEqual([
      { tip: 600, collected: 0, storePays: 600, keeps: 0 },     // card: tip added to the card, drawer pays the driver
      { tip: 400, collected: 2300, storePays: 0, keeps: 400 }, // cash: driver hands in the order, keeps the tip
    ]);
    expect(cashoutSummary([held, cash], { [held.order_id]: 600, [cash.order_id]: 400 }).handIn).toBe(1700);
  });

  it("a run of only card orders means the drawer pays the driver", () => {
    expect(cashoutSummary([held], { [held.order_id]: 500 }).handIn).toBe(-500);
  });

  describe("a tip taken on the phone before the card was approved (owner, 2026-10-31)", () => {
    // $30 delivery + $5 phone tip: the card was approved once for $35 and holds room for an extra tip.
    const tipped = posDeliveryOrderSchema.parse({ ...base, order_id: "a0000000-0000-4000-8000-000000000005", total_cents: 3500, tip_cents: 500, paid_by: "card_held", hold_cents: 3500 + 50_000, card_label: "Visa •4242" });

    it("is already on the card: with nothing typed, the drawer pays the driver $5 and nothing more is charged", () => {
      expect(tipOnCardCents(tipped)).toBe(500);
      const [line] = cashoutLines([tipped], {});
      expect(line).toMatchObject({ tip: 500, extra: 0, storePays: 500, collected: 0, keeps: 0 });
      expect(cashoutSummary([tipped], {})).toMatchObject({ cardTips: 500, handIn: -500 });
    });

    it("the tip box is the EXTRA on the slip: $5 on the phone + $2 extra = $7 to the driver", () => {
      const [line] = cashoutLines([tipped], { [tipped.order_id]: 200 });
      expect(line).toMatchObject({ tip: 700, extra: 200, storePays: 700 });
    });

    it("flags the phone tip typed again as an extra, before anything is charged", () => {
      expect(repeatedPhoneTips([tipped, held], { [tipped.order_id]: 500, [held.order_id]: 500 }).map(({ order, tipCents }) => [order.order_id, tipCents])).toEqual([[tipped.order_id, 500]]);
      expect(repeatedPhoneTips([tipped], { [tipped.order_id]: 300 })).toEqual([]);
      expect(repeatedPhoneTips([tipped], {})).toEqual([]);
    });

    it("says so on the Deliveries list", () => {
      expect(paidByLabel(tipped)).toBe("Visa •4242 · $5.00 tip on card");
      expect(paidByLabel(held)).toBe("Card · add tip");
    });

    it("leaves every other kind of delivery exactly as before", () => {
      expect(tipOnCardCents(charged)).toBe(0); // charged at the counter: its tip is read from the order as before
      expect(tipOnCardCents(cash)).toBe(0);
      expect(tipOnCardCents(held)).toBe(0);
      expect(cashoutSummary([cash, held, charged], { [cash.order_id]: 300, [held.order_id]: 500, [charged.order_id]: 400 })).toEqual({ cashOrders: 2300, cashTips: 300, cardTips: 900, tips: 1200, handIn: 1400 });
    });
  });
});
