import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureHeldCards } from "@/lib/payments/tip-capture";
import { PaymentProviderError, type ProviderPayment } from "@/lib/payments/provider";
import { startTipPostgres, workspaceId } from "./helpers/tip-postgres";

/**
 * Owner, 2026-10-29 (order #36 / W001228): a keyed card's tip is charged on its own and the
 * order is captured on its approval. The "order + tip" replacement is never created for new
 * operations. Real PostgreSQL (all migrations) + a fake Stripe that enforces capture limits.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/payments/config", () => ({ resolvePaymentProvider: async () => ({ ok: true, value: { provider } }) }));

const intents = new Map<string, ProviderPayment & { maxCapturableCents?: number | null }>();
const keys = new Map<string, string>();
let charges: { id: string; amount: number }[] = [];
let created: { id: string; amount: number }[] = [];
let declineTip = false;
let voidOriginalAfterTip: string | null = null;
const provider = {
  code: "stripe",
  getPaymentStatus: vi.fn(async (id: string) => ({ ...intents.get(id)! })),
  createSavedCardIntent: vi.fn(async (input: { idempotencyKey: string; amountCents: number }) => {
    const existing = keys.get(input.idempotencyKey);
    if (existing) return { ...intents.get(existing)! };
    const id = `pi_tip_${randomUUID()}`;
    keys.set(input.idempotencyKey, id);
    const intent: ProviderPayment = { providerPaymentId: id, status: "pending", providerStatus: "requires_confirmation", amountCents: input.amountCents, cardBrand: "visa", cardLast4: "3289", receiptUrl: null, failureReason: null };
    intents.set(id, intent); created.push({ id, amount: input.amountCents });
    return { ...intent };
  }),
  confirmSavedCardIntent: vi.fn(async (id: string) => {
    const intent = intents.get(id)!;
    if (intent.status !== "pending") return { ...intent };
    if (declineTip) Object.assign(intent, { status: "failed", providerStatus: "requires_payment_method", failureReason: "The card was declined. Try another card." });
    else { Object.assign(intent, { status: "captured", providerStatus: "succeeded" }); charges.push({ id, amount: intent.amountCents! }); }
    if (voidOriginalAfterTip) Object.assign(intents.get(voidOriginalAfterTip)!, { status: "voided", providerStatus: "canceled" });
    return { ...intent };
  }),
  capturePayment: vi.fn(async (id: string, input: { amountCents: number }) => {
    const intent = intents.get(id)!;
    if (intent.status === "captured") return { ...intent };
    if (intent.status !== "authorized") throw new PaymentProviderError("PaymentIntent is canceled", "payment_intent_unexpected_state", false);
    if (input.amountCents > (intent.maxCapturableCents ?? intent.amountCents!)) throw new PaymentProviderError("amount_to_capture exceeds amount_capturable", "amount_too_large", false);
    Object.assign(intent, { status: "captured", providerStatus: "succeeded", amountCents: input.amountCents }); charges.push({ id, amount: input.amountCents });
    return { ...intent };
  }),
  voidPayment: vi.fn(async (id: string) => { Object.assign(intents.get(id)!, { status: "voided", providerStatus: "canceled" }); return { ...intents.get(id)! }; }),
  releaseHold: vi.fn(async (id: string) => { Object.assign(intents.get(id)!, { status: "voided", providerStatus: "canceled" }); return { ...intents.get(id)! }; }),
};

describe("keyed delivery card: tip charged separately (durable coordinator)", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  beforeAll(async () => { db = await startTipPostgres(); }, 120_000);
  afterAll(async () => { await db?.stop(); });
  afterEach(async () => { await db.closeTestClients(); });
  beforeEach(() => { charges = []; created = []; declineTip = false; voidOriginalAfterTip = null; vi.clearAllMocks(); });

  async function keyed(room = 0) {
    const fixture = await db.fixture();
    intents.set(fixture.originalId, { providerPaymentId: fixture.originalId, status: "authorized", providerStatus: "requires_capture", amountCents: fixture.amount, maxCapturableCents: fixture.amount + room,
      paymentMethodId: room ? null : "pm_keyed", customerId: room ? null : "cus_keyed", cardBrand: "visa", cardLast4: "3289", receiptUrl: null, failureReason: null } as ProviderPayment);
    const { api } = await db.service();
    const run = (tip: number) => captureHeldCards({ service: api, workspaceId, locationId: null, requests: [{ order_id: fixture.orderId, tip_cents: tip }], keyPrefix: "driver-cashout" });
    return { ...fixture, run };
  }

  it("charges the tip alone, then the order on its approval — no order+tip charge, no release, no warning", async () => {
    const order = await keyed();
    const result = await order.run(300);
    expect(result.problems).toEqual([]);
    expect(result.captures[0]).toMatchObject({ captured_cents: order.amount + 300, tip_cents: 300 });
    expect(created.map((c) => c.amount)).toEqual([300]);
    expect(charges.map((c) => c.amount).sort()).toEqual([300, order.amount].sort());
    expect(provider.releaseHold).not.toHaveBeenCalled();
    const op = (await db.admin.query("select plan->>'mode' mode, state, replacement_id from public.pos_tip_operations where payment_id=$1", [order.paymentId])).rows[0];
    expect(op).toMatchObject({ mode: "separate_tip", state: "succeeded", replacement_id: null });
    expect((await order.run(300)).captures[0]).toMatchObject({ captured_cents: order.amount + 300 });
    expect(charges).toHaveLength(2);
  });

  it("declined tip: nothing charged, final message, retries never confirm again; tip 0 then charges the order alone", async () => {
    const order = await keyed(); declineTip = true;
    const first = await order.run(300);
    expect(first.problems[0]).toMatch(/declined the \$3\.00 tip\. Nothing was charged/);
    expect(charges).toEqual([]);
    await order.run(300);
    expect(provider.confirmSavedCardIntent).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    const zero = await order.run(0);
    expect(zero.captures[0]).toMatchObject({ captured_cents: order.amount, tip_cents: 0 });
    expect(charges.map((c) => c.amount)).toEqual([order.amount]);
  });

  it("approval gone after the tip charged: order not marked paid, tip never charged again", async () => {
    const order = await keyed(); voidOriginalAfterTip = order.originalId;
    const first = await order.run(300);
    expect(first.problems[0]).toMatch(/tip was charged on its own, but the order's card approval can't be charged.*NOT paid/);
    expect((await db.admin.query("select status from public.payments where id=$1", [order.paymentId])).rows[0].status).toBe("authorized");
    await order.run(300); await order.run(0);
    expect(charges.map((c) => c.amount)).toEqual([300]);
    expect(provider.voidPayment).not.toHaveBeenCalled();
  });

  it("approval already expired: no tip charged", async () => {
    const order = await keyed();
    Object.assign(intents.get(order.originalId)!, { status: "voided", providerStatus: "canceled" });
    const result = await order.run(300);
    expect(result.problems[0]).toMatch(/approval can't be charged \(canceled\)\. Nothing was charged/);
    expect(created).toEqual([]);
  });

  it("card with overcapture room keeps one capture for order + tip", async () => {
    const order = await keyed(5000);
    await order.run(300);
    expect(created).toEqual([]);
    expect(charges.map((c) => c.amount)).toEqual([order.amount + 300]);
  });
});
