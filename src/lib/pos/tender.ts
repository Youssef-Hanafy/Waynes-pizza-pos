import { z } from "zod";

/**
 * Counter payments (owner, 2026-09-23): the cashier types or taps the cash
 * handed over and sees the change at once; a card run on a standalone reader
 * is recorded with its last 4 digits / approval code.
 */

/** Change owed for cash handed over, or null while it's short of the amount due. */
export function changeDueCents(dueCents: number, tenderedCents: number): number | null {
  if (!Number.isInteger(dueCents) || !Number.isInteger(tenderedCents) || tenderedCents < dueCents) return null;
  return tenderedCents - dueCents;
}

/**
 * One-tap amounts for the cash screen: exact, the next whole dollar, the next
 * $5 / $10 / $20, and the common bills that cover the total.  Sorted, no repeats.
 */
export function quickCashAmounts(dueCents: number): number[] {
  if (!Number.isInteger(dueCents) || dueCents <= 0) return [];
  const up = (step: number) => Math.ceil(dueCents / step) * step;
  const candidates = [dueCents, up(100), up(500), up(1000), up(2000), 5000, 10000].filter((amount) => amount >= dueCents);
  return [...new Set(candidates)].sort((a, b) => a - b).slice(0, 6);
}

/** What the POS sends when a card was run on a reader that isn't linked to it. */
export const cardReaderPaymentSchema = z.object({
  order_id: z.uuid(),
  idempotency_key: z.string().min(16).max(200),
  card_last4: z.string().trim().regex(/^(\d{4})?$/, "Enter the last 4 digits of the card, or leave it blank.").default(""),
  approval_code: z.string().trim().max(40, "That approval code is too long.").default(""),
  processor: z.string().trim().max(60).default("Card reader"),
});
export type CardReaderPayment = z.infer<typeof cardReaderPaymentSchema>;
