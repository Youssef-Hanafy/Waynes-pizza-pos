import { describe, expect, it } from "vitest";
import { cashoutLines, cashoutSummary, maxTipCents, posDeliveryOrderSchema, tipAllowed } from "./pos-board";

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
});
