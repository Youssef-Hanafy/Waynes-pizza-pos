import { z } from "zod";

export const cardDayBatchResultSchema = z.object({
  outcome: z.enum(["queued", "existing", "empty", "unavailable"]),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  message: z.string().optional(),
  batch: z.object({
    id: z.uuid(), state: z.string(), queued_at: z.string(),
    card_count: z.coerce.number().int().nonnegative(), recorded_card_cents: z.coerce.number().int(),
    refund_count: z.coerce.number().int().nonnegative(), recorded_refund_cents: z.coerce.number().int(),
    gross_cents: z.coerce.number().int().nullable(), refund_cents: z.coerce.number().int().nullable(),
    fee_cents: z.coerce.number().int().nullable(), net_cents: z.coerce.number().int().nullable(),
  }).nullable(),
});
export type CardDayBatchResult = z.infer<typeof cardDayBatchResultSchema>;

export function cardBatchReference(day: string, id: string) {
  return `CC-${day.replaceAll("-", "")}-${id.slice(0, 8).toUpperCase()}`;
}

export function cardBatchConfirmation(result: CardDayBatchResult) {
  if (!result.batch) return result.message ?? "No credit card batch was queued.";
  const label = `Batch ${cardBatchReference(result.day, result.batch.id)}`;
  switch (result.batch.state) {
    case "waiting": return `${label} ${result.outcome === "queued" ? "confirmed queued" : "is already queued"} to send to the bank after settlement, minus refunds and fees.`;
    case "submitting": return `${label} is checking its bank payout request. No duplicate payout was created.`;
    case "pending":
    case "in_transit": return `${label} already has a bank payout requested. No duplicate payout was created.`;
    case "paid": return `${label} has already been paid by Stripe. No new payout was queued.`;
    case "no_payout": return `${label} has no proceeds to send after refunds and fees.`;
    default: return `${label} needs review before it can be sent. Check the batch status below.`;
  }
}
