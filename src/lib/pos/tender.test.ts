import { describe, expect, it } from "vitest";
import { cardReaderPaymentSchema, changeDueCents, quickCashAmounts } from "./tender";

describe("counter cash", () => {
  it("works out the change, and nothing while the cash is short", () => {
    expect(changeDueCents(2345, 5000)).toBe(2655);
    expect(changeDueCents(2345, 2345)).toBe(0);
    expect(changeDueCents(2345, 2000)).toBeNull();
  });

  it("offers exact, the next dollar, and the bills that cover it", () => {
    expect(quickCashAmounts(2345)).toEqual([2345, 2400, 2500, 3000, 4000, 5000]);
    expect(quickCashAmounts(2000)).toEqual([2000, 5000, 10000]);
    expect(quickCashAmounts(0)).toEqual([]);
  });
});

describe("card run on a standalone reader", () => {
  it("accepts a blank or 4-digit last 4, nothing else", () => {
    const base = { order_id: "66000000-0000-4000-8000-000000000001", idempotency_key: "pos-card-0000000000001" };
    expect(cardReaderPaymentSchema.safeParse({ ...base, card_last4: "4242" }).success).toBe(true);
    expect(cardReaderPaymentSchema.safeParse(base).success).toBe(true);
    expect(cardReaderPaymentSchema.safeParse({ ...base, card_last4: "42" }).success).toBe(false);
  });
});
