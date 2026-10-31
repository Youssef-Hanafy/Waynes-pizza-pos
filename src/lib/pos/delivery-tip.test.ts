import { describe, expect, it } from "vitest";
import { attemptAfter, keyedCheckoutView, MAX_TIP_CENTS, parseTipDollars, parseTipPercent, tipCentsFor, tipLocked, type KeyedAttempt } from "./delivery-tip";

describe("tip before payment on a keyed card (owner, 2026-10-31)", () => {
  it("$30 delivery + $5 driver tip shows and charges ONE $35 amount", () => {
    const view = keyedCheckoutView({ orderCents: 3000, tipCents: 500, delivery: true, paidBefore: 0, busy: false });
    expect(view).toMatchObject({ tipOffered: true, orderCents: 3000, tipCents: 500, chargeCents: 3500 });
    expect(view.buttonLabel).toBe("Approve $35.00 on the card (incl. $5.00 driver tip)");
    expect(view.note).toContain("One approval for $35.00: order $30.00 + $5.00 driver tip");
    expect(view.note).toContain("add only the extra in Deliveries");
  });

  it("a delivery with no tip yet still says the tip can be added now or at cash-out", () => {
    const view = keyedCheckoutView({ orderCents: 3000, tipCents: 0, delivery: true, paidBefore: 0, busy: false });
    expect(view.chargeCents).toBe(3000);
    expect(view.buttonLabel).toBe("Approve $30.00 on the card");
    expect(view.note).toMatch(/Add a tip here .* or add it from the signed slip in Deliveries/);
  });

  it("the total follows the tip immediately as it changes", () => {
    for (const [tip, total] of [[0, 3000], [300, 3300], [1000, 4000], [450, 3450]] as const) {
      expect(keyedCheckoutView({ orderCents: 3000, tipCents: tip, delivery: true, paidBefore: 0, busy: false }).chargeCents).toBe(total);
    }
  });

  it("the rest of a partly paid order takes no tip, whatever is typed", () => {
    const view = keyedCheckoutView({ orderCents: 800, tipCents: 500, delivery: true, paidBefore: 3000, busy: false });
    expect(view).toMatchObject({ tipOffered: false, tipCents: 0, chargeCents: 800 });
  });

  it("a phone pickup keeps its wording (charged now, order closed)", () => {
    const view = keyedCheckoutView({ orderCents: 2000, tipCents: 300, delivery: false, paidBefore: 0, busy: false });
    expect(view.buttonLabel).toBe("Approve $23.00 (incl. $3.00 tip) on the card");
    expect(view.note).toBe("The card is charged now, tip included, and the order is closed.");
  });

  it("dollar tips: typed amounts, blanks and nonsense", () => {
    expect(parseTipDollars("5")).toBe(500);
    expect(parseTipDollars("$5.50")).toBe(550);
    expect(parseTipDollars("")).toBe(0);
    expect(parseTipDollars("5.555")).toBeNull();
    expect(parseTipDollars("abc")).toBeNull();
    expect(parseTipDollars("2000")).toBeNull(); // over the $1,000 ceiling
    expect(tipCentsFor({ kind: "amount", cents: 500 }, 3000)).toBe(500);
    expect(tipCentsFor({ kind: "amount", cents: MAX_TIP_CENTS + 1 }, 3000)).toBe(MAX_TIP_CENTS);
    expect(tipCentsFor({ kind: "amount", cents: -100 }, 3000)).toBe(0);
  });

  it("percentage tips are of the order before the tip, rounded to the cent", () => {
    expect(tipCentsFor({ kind: "percent", percent: 15 }, 3000)).toBe(450);
    expect(tipCentsFor({ kind: "percent", percent: 18 }, 3333)).toBe(600);
    expect(tipCentsFor({ kind: "percent", percent: 17.5 }, 2999)).toBe(525);
    expect(tipCentsFor({ kind: "none" }, 3000)).toBe(0);
    expect(parseTipPercent("18%")).toBe(18);
    expect(parseTipPercent("17.5")).toBe(17.5);
    expect(parseTipPercent("")).toBe(0);
    expect(parseTipPercent("150")).toBeNull();
    expect(parseTipPercent("1.25")).toBeNull();
  });

  describe("the amount locks once the approval begins", () => {
    const authorizing: KeyedAttempt = { phase: "authorizing", amountCents: 3500, tipCents: 500 };
    it("the tip can change only before anything is sent to Stripe", () => {
      expect(tipLocked({ phase: "idle" })).toBe(false);
      expect(tipLocked(authorizing)).toBe(true);
    });
    it("a definite decline closes the attempt and unlocks the tip for the next card", () => {
      expect(attemptAfter(authorizing, { kind: "declined" }, "p1")).toEqual({ phase: "idle" });
    });
    it("approved (held for the driver, or charged) is final at the same amount", () => {
      expect(attemptAfter(authorizing, { kind: "authorized" }, "p1")).toEqual({ phase: "done", amountCents: 3500, tipCents: 500 });
      expect(attemptAfter(authorizing, { kind: "captured" }, "p1")).toEqual({ phase: "done", amountCents: 3500, tipCents: 500 });
    });
    it("no answer or still processing stays LOCKED at the same amount, to be checked again — never retried with a new total", () => {
      const unknown = attemptAfter(authorizing, { kind: "no_answer" }, "p1");
      expect(unknown).toEqual({ phase: "unknown", paymentId: "p1", amountCents: 3500, tipCents: 500 });
      expect(tipLocked(unknown)).toBe(true);
      expect(attemptAfter(authorizing, { kind: "pending" }, "p1").phase).toBe("unknown");
      // Checking again keeps the same payment and amount until Stripe gives a definite answer.
      expect(attemptAfter(unknown, { kind: "pending" }, null)).toEqual(unknown);
      expect(attemptAfter(unknown, { kind: "authorized" }, "p1")).toEqual({ phase: "done", amountCents: 3500, tipCents: 500 });
    });
    it("a finished attempt can't be reopened", () => {
      const done: KeyedAttempt = { phase: "done", amountCents: 3500, tipCents: 500 };
      expect(attemptAfter(done, { kind: "declined" }, "p1")).toBe(done);
    });
  });
});
