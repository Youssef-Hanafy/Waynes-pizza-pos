import { describe, expect, it } from "vitest";
import { cardBatchConfirmation, cardDayBatchResultSchema, type CardDayBatchResult } from "./card-batch";

const result = (state = "waiting", outcome: CardDayBatchResult["outcome"] = "queued"): CardDayBatchResult => ({
  day: "2026-11-05", outcome,
  batch: { id: "12345678-1234-4234-8234-123456789abc", state, queued_at: "2026-11-06T01:00:00Z", card_count: 10,
    recorded_card_cents: 100000, refund_count: 1, recorded_refund_cents: 5000, gross_cents: null, refund_cents: null, fee_cents: null, net_cents: null },
});
describe("Credit card batch confirmation", () => {
  it("confirms a saved batch identity and settlement queue without inventing a final amount", () => {
    expect(cardBatchConfirmation(result())).toBe("Batch CC-20261105-12345678 confirmed queued to send to the bank after settlement, minus refunds and fees.");
    expect(cardDayBatchResultSchema.parse(result()).batch?.net_cents).toBeNull();
  });
  it("explains a repeat click and distinguishes completed or failed transfers from queued ones", () => {
    expect(cardBatchConfirmation(result("waiting", "existing"))).toContain("already queued");
    expect(cardBatchConfirmation(result("paid", "existing"))).toContain("already been paid");
    expect(cardBatchConfirmation(result("pending", "existing"))).toContain("already has a bank payout requested");
    expect(cardBatchConfirmation(result("review", "existing"))).toContain("needs review");
    expect(cardBatchConfirmation(result("failed", "existing"))).not.toContain("confirmed queued");
  });
  it("does not confirm a batch when the day is empty or the store is disabled", () => {
    expect(cardBatchConfirmation({ day: "2026-11-05", outcome: "empty", batch: null, message: "No Stripe card payments to close out." })).toBe("No Stripe card payments to close out.");
    expect(cardBatchConfirmation({ day: "2026-11-05", outcome: "unavailable", batch: null, message: "Batch closeout is not enabled." })).not.toContain("confirmed queued");
  });
});
