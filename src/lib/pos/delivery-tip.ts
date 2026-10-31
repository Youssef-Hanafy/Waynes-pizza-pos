/**
 * Tip before payment on a keyed (phone) card (owner, 2026-10-31).
 *
 * A customer calls in a delivery, pays by card over the phone and wants to
 * add the driver's tip right then: $30 order + $5 tip → the card is approved
 * ONCE for $35.  The $5 is saved on the order (orders.tip_cents) before the
 * approval is created, so the order, the receipt and the driver's cash-out all
 * read the same tip and nothing charges it a second time.
 *
 * Two workflows, kept apart on purpose:
 *   A. Tip before the card is approved  → one combined approval (this file).
 *   B. Tip added after the approval     → the existing durable tip operation
 *      at the driver's cash-out (src/lib/payments/tip-operation.ts), which
 *      only ever charges the EXTRA on top of what the approval already holds.
 *
 * Pure functions only, so the screen's rules can be tested without a browser.
 */

/** Same ceiling as /api/pos/orders/[id]/tip and wayne_pos_set_tip. */
export const MAX_TIP_CENTS = 100_000;

/** A tip typed or tapped on the payment screen. */
export type TipChoice =
  | { kind: "none" }
  | { kind: "amount"; cents: number }
  | { kind: "percent"; percent: number };

/** Dollars typed on the payment screen ("5", "5.50", "$5.50"). "" is no tip; null is not a valid amount. */
export function parseTipDollars(text: string): number | null {
  const clean = text.replace(/[$,\s]/g, "");
  if (!clean) return 0;
  if (!/^\d{1,4}(\.\d{0,2})?$/.test(clean)) return null;
  const cents = Math.round(Number(clean) * 100);
  return cents > MAX_TIP_CENTS ? null : cents;
}

/** A percentage typed on the payment screen ("15", "17.5", "18%"). "" is no tip; null is not a valid percentage. */
export function parseTipPercent(text: string): number | null {
  const clean = text.replace(/[%\s]/g, "");
  if (!clean) return 0;
  if (!/^\d{1,3}(\.\d)?$/.test(clean)) return null;
  const percent = Number(clean);
  return percent > 100 ? null : percent;
}

/**
 * The tip in cents. A percentage is of the order before the tip (food, delivery
 * fee and tax — what the customer hears as "the order"), rounded to the cent.
 */
export function tipCentsFor(choice: TipChoice, orderCents: number): number {
  const base = Math.max(0, Math.round(orderCents));
  const raw = choice.kind === "amount" ? choice.cents : choice.kind === "percent" ? Math.round((base * choice.percent) / 100) : 0;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(Math.max(0, Math.round(raw)), MAX_TIP_CENTS);
}

/**
 * Where a keyed card attempt stands. The tip can be changed only while
 * nothing has been sent to Stripe ("idle"), or after Stripe definitely
 * declined the card (back to "idle").  From the moment the approval is
 * being created the amount is locked; an answer we couldn't read
 * ("unknown") stays locked until the card is checked again.
 */
export type KeyedAttempt =
  | { phase: "idle" }
  | { phase: "authorizing"; amountCents: number; tipCents: number }
  | { phase: "unknown"; paymentId: string | null; amountCents: number; tipCents: number }
  | { phase: "done"; amountCents: number; tipCents: number };

/** What the server said after the card was confirmed (or what went wrong getting there). */
export type KeyedOutcome =
  | { kind: "captured" | "authorized" }
  | { kind: "declined" }
  | { kind: "pending" }
  /** No reliable answer (timeout, network): the card may or may not have been approved. */
  | { kind: "no_answer" };

export function attemptAfter(attempt: KeyedAttempt, outcome: KeyedOutcome, paymentId: string | null): KeyedAttempt {
  if (attempt.phase === "idle" || attempt.phase === "done") return attempt;
  const amounts = { amountCents: attempt.amountCents, tipCents: attempt.tipCents };
  switch (outcome.kind) {
    case "captured":
    case "authorized": return { phase: "done", ...amounts };
    // Stripe answered "declined": that approval is closed (wayne_settle_payment → failed), so the tip may change.
    case "declined": return { phase: "idle" };
    default: return { phase: "unknown", paymentId: paymentId ?? (attempt.phase === "unknown" ? attempt.paymentId : null), ...amounts };
  }
}

export function tipLocked(attempt: KeyedAttempt) {
  return attempt.phase !== "idle";
}

export type KeyedCheckoutView = {
  /** Whether this card takes a tip now (not on the rest of an order that was already partly paid). */
  tipOffered: boolean;
  /** The order alone (what is owed before the tip). */
  orderCents: number;
  tipCents: number;
  /** The single amount the card is approved / charged for. */
  chargeCents: number;
  /** The button's words. */
  buttonLabel: string;
  /** One line under the total explaining what happens to the tip. */
  note: string;
};

const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/**
 * What the keyed-card box shows and charges. `orderCents` is what is owed
 * before any tip; the charge is ALWAYS order + tip, one amount.
 */
export function keyedCheckoutView(input: { orderCents: number; tipCents: number; delivery: boolean; paidBefore: number; busy: boolean }): KeyedCheckoutView {
  // No tip on the rest of an order that was already partly paid (owner, 2026-10-19).
  const tipOffered = input.paidBefore <= 0;
  const tip = tipOffered ? Math.min(Math.max(0, input.tipCents), MAX_TIP_CENTS) : 0;
  const charge = input.orderCents + tip;
  const tipWords = tip ? ` (incl. ${money(tip)} ${input.delivery ? "driver tip" : "tip"})` : "";
  const buttonLabel = input.busy ? "Processing…"
    : input.delivery ? `Approve ${money(charge)} on the card${tipWords}`
    : `Approve ${money(charge)}${tip ? ` (incl. ${money(tip)} tip)` : ""} on the card`;
  const note = !tipOffered ? `The rest of the order: ${money(input.orderCents)} (no tip on this part).`
    : input.delivery
      ? tip
        ? `One approval for ${money(charge)}: order ${money(input.orderCents)} + ${money(tip)} driver tip. The tip is saved for the driver's cash-out and is never charged again. If the signed slip shows more, add only the extra in Deliveries.`
        : `The card is approved for ${money(charge)} now. Add a tip here if the customer gives one on the phone, or add it from the signed slip in Deliveries at the driver's cash-out.`
      : "The card is charged now, tip included, and the order is closed.";
  return { tipOffered, orderCents: input.orderCents, tipCents: tip, chargeCents: charge, buttonLabel, note };
}
