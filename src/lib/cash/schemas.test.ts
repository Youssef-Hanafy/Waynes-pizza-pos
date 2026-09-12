import { describe, expect, it } from "vitest";
import {
  cashErrorMessage, cashMovementDirection, drawerActionSchema, expectedCashCents,
  needsVarianceNote, parseCashCountInput, varianceCents, varianceLabel,
} from "./schemas";

const shift = {
  opening_cash_cents: 15000,
  cash_sales_cents: 2000,
  cash_refunds_cents: 0,
  paid_in_cents: 500,
  paid_out_cents: 1200,
  drop_cents: 1000,
  driver_cash_cents: 2500,
};

describe("expected cash", () => {
  it("is the float plus what came in, less what went out", () => {
    // 15000 + 2000 - 0 + 500 + 2500 - 1200 - 1000
    expect(expectedCashCents(shift)).toBe(17800);
  });

  it("is just the float on a drawer nothing has happened to", () => {
    expect(expectedCashCents({
      opening_cash_cents: 15000, cash_sales_cents: 0, cash_refunds_cents: 0,
      paid_in_cents: 0, paid_out_cents: 0, drop_cents: 0, driver_cash_cents: 0,
    })).toBe(15000);
  });

  it("takes refunds back out of the drawer", () => {
    expect(expectedCashCents({ ...shift, cash_refunds_cents: 800 })).toBe(17000);
  });

  it("agrees with the direction each movement is supposed to go", () => {
    expect(cashMovementDirection.paid_in).toBe(1);
    expect(cashMovementDirection.driver_cash).toBe(1);
    expect(cashMovementDirection.paid_out).toBe(-1);
    expect(cashMovementDirection.drop).toBe(-1);
  });
});

describe("variance", () => {
  it("is negative when the drawer is short and positive when it is over", () => {
    expect(varianceCents(17750, 17800)).toBe(-50);
    expect(varianceCents(17850, 17800)).toBe(50);
    expect(varianceCents(17800, 17800)).toBe(0);
  });

  it("is named the way a manager would say it", () => {
    expect(varianceLabel(-50)).toBe("Short");
    expect(varianceLabel(50)).toBe("Over");
    expect(varianceLabel(0)).toBe("Balanced");
  });

  it("demands an explanation once real money is missing", () => {
    expect(needsVarianceNote(-499, "")).toBe(false);
    expect(needsVarianceNote(-500, "")).toBe(true);
    expect(needsVarianceNote(500, "")).toBe(true);
    expect(needsVarianceNote(-1500, "  ")).toBe(true);
    expect(needsVarianceNote(-1500, "Miscount on change")).toBe(false);
  });
});

describe("counted amounts", () => {
  it("accepts zero, because an empty drawer is a real count", () => {
    expect(parseCashCountInput("0")).toEqual({ ok: true, cents: 0 });
    expect(parseCashCountInput("0.00")).toEqual({ ok: true, cents: 0 });
  });

  it("accepts dollars, decimals and typed currency symbols", () => {
    expect(parseCashCountInput("150")).toEqual({ ok: true, cents: 15000 });
    expect(parseCashCountInput("$1,234.56")).toEqual({ ok: true, cents: 123456 });
  });

  it("refuses nothing, nonsense and negatives", () => {
    expect(parseCashCountInput("").ok).toBe(false);
    expect(parseCashCountInput("a lot").ok).toBe(false);
    expect(parseCashCountInput("12.345").ok).toBe(false);
    expect(parseCashCountInput("-20").ok).toBe(false);
  });
});

describe("drawer actions", () => {
  const shiftId = "0b3f1a54-7a2c-4d1e-9a44-5e0f1b2c3d4e";
  const registerId = "1c4f2b65-8b3d-4e2f-8b55-6f1a2c3d4e5f";

  it("lets a drawer open with a zero float but not a negative one", () => {
    expect(drawerActionSchema.safeParse({ action: "open", register_id: registerId, opening_cash_cents: 0 }).success).toBe(true);
    expect(drawerActionSchema.safeParse({ action: "open", register_id: registerId, opening_cash_cents: -1 }).success).toBe(false);
  });

  it("requires a reason of real length on every movement", () => {
    expect(drawerActionSchema.safeParse({ action: "movement", shift_id: shiftId, kind: "paid_out", amount_cents: 500, reason: "Napkins" }).success).toBe(true);
    expect(drawerActionSchema.safeParse({ action: "movement", shift_id: shiftId, kind: "paid_out", amount_cents: 500, reason: "no" }).success).toBe(false);
  });

  it("refuses a movement of nothing and an unknown kind", () => {
    expect(drawerActionSchema.safeParse({ action: "movement", shift_id: shiftId, kind: "paid_out", amount_cents: 0, reason: "Napkins" }).success).toBe(false);
    expect(drawerActionSchema.safeParse({ action: "movement", shift_id: shiftId, kind: "skim", amount_cents: 500, reason: "Napkins" }).success).toBe(false);
  });

  it("accepts a close with a count and an optional note", () => {
    expect(drawerActionSchema.safeParse({ action: "close", shift_id: shiftId, counted_cash_cents: 0, close_note: "" }).success).toBe(true);
    expect(drawerActionSchema.safeParse({ action: "close", shift_id: shiftId, counted_cash_cents: -1 }).success).toBe(false);
  });

  it("requires an idempotency key long enough to be unique on a cash payment", () => {
    const base = { action: "cash_payment", shift_id: shiftId, order_id: registerId, tendered_cents: 2000 };
    expect(drawerActionSchema.safeParse({ ...base, idempotency_key: "pos-cash-key-000001" }).success).toBe(true);
    expect(drawerActionSchema.safeParse({ ...base, idempotency_key: "short" }).success).toBe(false);
  });

  it("rejects an action it does not know", () => {
    expect(drawerActionSchema.safeParse({ action: "empty_till", shift_id: shiftId }).success).toBe(false);
  });
});

describe("cash error messages", () => {
  it("explains the two conflicts a counter actually hits", () => {
    expect(cashErrorMessage({ code: "40001", message: "That register already has an open drawer" })).toContain("already has an open drawer");
    expect(cashErrorMessage({ code: "40001", message: "A payment on this drawer has not finished" })).toContain("Refresh");
    expect(cashErrorMessage({ code: "42501", message: "Cash management permission required" })).toContain("not allowed");
  });

  it("passes through safe database messages and hides the rest", () => {
    expect(cashErrorMessage({ code: "22023", message: "That is more cash than the drawer is holding" }))
      .toBe("That is more cash than the drawer is holding");
    expect(cashErrorMessage({ code: "42P01", message: 'relation "public.register_shifts" does not exist' }))
      .toBe("That could not be saved. Check the drawer before retrying.");
  });
});
