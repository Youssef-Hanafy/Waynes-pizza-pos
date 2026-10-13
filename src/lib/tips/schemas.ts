import { z } from "zod";

/** A card approved and held for the tip on its signed slip (database: wayne_pos_tip_queue). */
export const heldCardSchema = z.object({
  order_id: z.uuid(),
  order_number: z.string(),
  customer_name: z.string().nullable().transform((value) => value ?? ""),
  source: z.string(),
  fulfillment_type: z.string(),
  total_cents: z.number().int(),
  tip_already_cents: z.number().int(),
  is_test: z.boolean(),
  placed_at: z.string(),
  payment_id: z.uuid(),
  provider: z.string(),
  authorized_cents: z.number().int(),
  card_brand: z.string().nullable(),
  card_last4: z.string().nullable(),
  authorized_at: z.string(),
  max_capture_cents: z.number().int(),
  entry: z.string(),
  /** On a driver's run: its tip goes in through Deliveries → cash-out. */
  with_driver: z.boolean(),
});
export type HeldCard = z.infer<typeof heldCardSchema>;

export const tipCaptureRequestSchema = z.object({
  tips: z.array(z.object({ order_id: z.uuid(), tip_cents: z.number().int().min(0).max(100_000) })).min(1).max(100),
});

/** The most tip that fits on the card (Stripe overcapture). */
export function tipRoom(card: Pick<HeldCard, "authorized_cents" | "max_capture_cents">) {
  return Math.max(0, card.max_capture_cents - card.authorized_cents);
}

/** Dollars typed from a slip ("4", "4.50", "$4.50") as cents; "" is no tip; null is not a number. */
export function parseTipInput(text: string): number | null {
  const clean = text.replace(/[$,\s]/g, "");
  if (!clean) return 0;
  if (!/^\d{1,4}(\.\d{0,2})?$/.test(clean)) return null;
  return Math.round(Number(clean) * 100);
}
