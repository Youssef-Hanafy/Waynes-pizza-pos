import { describe, expect, it } from "vitest";
import { dayOrderSchema, matchesSearch, paymentSummary } from "./day-orders";

const order = dayOrderSchema.parse({
  id: "66000000-0000-4000-8000-000000000001", order_number: "W000123", customer_name: "John Smith", customer_phone: "5085551234",
  fulfillment_type: "pickup", source: "pos", phone_line: null, status: "ready", payment_method: "card", payment_status: "paid",
  subtotal_cents: 2000, discount_cents: 0, delivery_fee_cents: 0, tax_cents: 140, tip_cents: 0, total_cents: 2140,
  placed_at: "2026-10-12T18:00:00Z", promised_at: null, ready_at: null, out_for_delivery_at: null, completed_at: null, cancelled_at: null,
  is_test: false, delivery_address: null, special_instructions: null, taken_by: "Ehab", item_count: 2,
  paid_method: "card", card_brand: "visa", card_last4: "4242", tendered_cents: null, change_cents: null, paid_at: "2026-10-12T18:01:00Z",
});

describe("today's orders (owner, 2026-10-12)", () => {
  it("finds an order by number, name or phone", () => {
    expect(matchesSearch(order, "123")).toBe(true);
    expect(matchesSearch(order, "W000123")).toBe(true);
    expect(matchesSearch(order, "smith")).toBe(true);
    expect(matchesSearch(order, "555-1234")).toBe(true);
    expect(matchesSearch(order, "jane")).toBe(false);
  });
  it("says how it was paid", () => {
    expect(paymentSummary(order)).toBe("Paid · Visa ····4242");
    expect(paymentSummary({ ...order, paid_method: "cash", card_last4: null })).toBe("Paid · Cash");
    expect(paymentSummary({ ...order, payment_status: "unpaid", payment_method: "cash", paid_method: null })).toBe("Not paid · cash due");
  });
});
