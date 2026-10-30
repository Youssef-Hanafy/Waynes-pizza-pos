import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Keyed delivery cards (owner, 2026-10-29, order #36 / W001228): the tip is charged
 * on its own and the order on its approval — never one new "order + tip" charge.
 * A fake Stripe stands in for the real one; nothing here talks to Stripe.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const stripe = {
  code: "stripe",
  getPaymentStatus: vi.fn(),
  capturePayment: vi.fn(),
  chargeSavedCard: vi.fn(),
  releaseHold: vi.fn(),
};
vi.mock("./config", () => ({ resolvePaymentProvider: vi.fn(async () => ({ ok: true, value: { provider: stripe } })) }));

const { captureHeldCards } = await import("./tip-capture");
const { PaymentProviderError } = await import("./provider");

type Row = Record<string, unknown>;
function fakeService(row: Row) {
  const updates: Row[] = [];
  const builder = {
    select: () => builder, in: () => builder, eq: () => builder,
    then: (resolve: (value: { data: Row[]; error: null }) => unknown) => resolve({ data: [row], error: null }),
  };
  const service = {
    from: () => ({
      select: () => builder,
      update: (values: Row) => { updates.push(values); row.metadata = values.metadata; return { eq: async () => ({ error: null }) }; },
    }),
  };
  return { service: service as never, updates };
}

const heldRow = (metadata: Row = {}): Row => ({
  id: "pay-36", order_id: "order-36", provider: "stripe", provider_payment_id: "pi_order", amount_cents: 4603,
  card_brand: "visa", card_last4: "3289", metadata: { held_for: "delivery_tip", tip_adjust: true, ...metadata },
  order: { order_number: "W001228", daily_number: 36 },
});
const authorized = { status: "authorized", amountCents: 4603, maxCapturableCents: 4603, paymentMethodId: "pm_1", customerId: "cus_1", cardBrand: "visa", cardLast4: "3289" };
const run = (row: Row, tip = 300) => {
  const { service, updates } = fakeService(row);
  return captureHeldCards({ service, workspaceId: "w", locationId: null, requests: [{ order_id: "order-36", tip_cents: tip }], keyPrefix: "driver-cashout" }).then((result) => ({ result, updates }));
};

beforeEach(() => {
  vi.clearAllMocks();
  stripe.getPaymentStatus.mockResolvedValue(authorized);
  stripe.capturePayment.mockResolvedValue({ status: "captured", amountCents: 4603, providerPaymentId: "pi_order", cardBrand: "visa", cardLast4: "3289" });
  stripe.chargeSavedCard.mockResolvedValue({ status: "captured", amountCents: 300, providerPaymentId: "pi_tip", cardBrand: "visa", cardLast4: "3289" });
});

describe("keyed delivery card tips are charged separately from the order", () => {
  it("#36: charges the $3 tip alone, then the $46.03 order on its approval — never $49.03, no warning", async () => {
    const { result, updates } = await run(heldRow());
    expect(stripe.chargeSavedCard).toHaveBeenCalledTimes(1);
    expect(stripe.chargeSavedCard.mock.calls[0]![0]).toMatchObject({ amountCents: 300, idempotencyKey: "driver-cashout-tiponly-pay-36-300" });
    expect(stripe.chargeSavedCard.mock.calls.some(([input]) => input.amountCents === 4903)).toBe(false);
    expect(stripe.capturePayment).toHaveBeenCalledWith("pi_order", { amountCents: 4603, idempotencyKey: "driver-cashout-pay-36-4603" });
    expect(stripe.releaseHold).not.toHaveBeenCalled();
    expect(result.captures).toEqual([expect.objectContaining({ captured_cents: 4903, tip_cents: 300 })]);
    expect(result.problems).toEqual([]);
    expect(updates[0]!.metadata).toMatchObject({ tip_charge_intent: "pi_tip", tip_charge_cents: 300, tip_charged_separately: true });
  });

  it("tip refused: nothing is charged, the card stays waiting with the tip", async () => {
    stripe.chargeSavedCard.mockRejectedValue(new PaymentProviderError("The card was declined. Try another card.", "card_declined", false));
    const { result } = await run(heldRow());
    expect(stripe.capturePayment).not.toHaveBeenCalled();
    expect(result.captures).toEqual([]);
    expect(result.skipped).toEqual(["order-36"]);
    expect(result.problems[0]).toMatch(/#36: Stripe refused the \$3\.00 tip .*Nothing was charged/);
  });

  it("no answer on the tip: nothing captured, safe to retry with the same key", async () => {
    stripe.chargeSavedCard.mockRejectedValue(new PaymentProviderError("The payment network did not answer.", "NETWORK", true));
    const { result } = await run(heldRow());
    expect(stripe.capturePayment).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(["order-36"]);
  });

  it("retry after the tip went through but the order didn't: the tip is not charged again", async () => {
    const { result } = await run(heldRow({ tip_charge_intent: "pi_tip", tip_charge_cents: 300, tip_charged_separately: true }));
    expect(stripe.chargeSavedCard).not.toHaveBeenCalled();
    expect(stripe.capturePayment).toHaveBeenCalledWith("pi_order", { amountCents: 4603, idempotencyKey: "driver-cashout-pay-36-4603" });
    expect(result.captures).toEqual([expect.objectContaining({ captured_cents: 4903, tip_cents: 300 })]);
  });

  it("tip changed after one was already charged on its own: stops, charges nothing more", async () => {
    const { result } = await run(heldRow({ tip_charge_intent: "pi_tip", tip_charge_cents: 300 }), 500);
    expect(stripe.chargeSavedCard).not.toHaveBeenCalled();
    expect(stripe.capturePayment).not.toHaveBeenCalled();
    expect(result.problems[0]).toMatch(/\$3\.00 tip was already charged/);
    const zero = await run(heldRow({ tip_charge_intent: "pi_tip", tip_charge_cents: 300 }), 0);
    expect(stripe.capturePayment).not.toHaveBeenCalled();
    expect(zero.result.skipped).toEqual(["order-36"]);
  });

  it("order capture loses its answer after the tip: Stripe's captured order + the tip are recorded", async () => {
    stripe.capturePayment.mockRejectedValue(new PaymentProviderError("The payment network did not answer.", "NETWORK", true));
    stripe.getPaymentStatus.mockResolvedValueOnce(authorized).mockResolvedValueOnce({ ...authorized, status: "captured" });
    const { result } = await run(heldRow());
    expect(result.captures).toEqual([expect.objectContaining({ captured_cents: 4903, tip_cents: 300 })]);
  });

  it("no tip: the order alone is captured on its approval, no extra charge", async () => {
    const { result } = await run(heldRow(), 0);
    expect(stripe.chargeSavedCard).not.toHaveBeenCalled();
    expect(stripe.capturePayment).toHaveBeenCalledWith("pi_order", { amountCents: 4603, idempotencyKey: "driver-cashout-pay-36-4603" });
    expect(result.captures).toEqual([expect.objectContaining({ captured_cents: 4603, tip_cents: 0 })]);
  });

  it("an M2 card with overcapture room still takes the tip on its own approval (one capture)", async () => {
    stripe.getPaymentStatus.mockResolvedValue({ ...authorized, maxCapturableCents: 9603, paymentMethodId: null, customerId: null });
    stripe.capturePayment.mockResolvedValue({ status: "captured", amountCents: 4903, providerPaymentId: "pi_order" });
    const { result } = await run(heldRow());
    expect(stripe.chargeSavedCard).not.toHaveBeenCalled();
    expect(stripe.capturePayment).toHaveBeenCalledWith("pi_order", { amountCents: 4903, idempotencyKey: "driver-cashout-pay-36-4903" });
    expect(result.captures).toEqual([expect.objectContaining({ captured_cents: 4903, tip_cents: 300 })]);
  });
});
