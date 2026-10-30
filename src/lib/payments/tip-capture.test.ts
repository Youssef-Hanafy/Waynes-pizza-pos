import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startTipPostgres, workspaceId } from "../../../tests/helpers/tip-postgres";
import type { ProviderPayment } from "./provider";

// Preserve the live Order #36 acceptance cases through the durable SQL coordinator.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("./config", () => ({ resolvePaymentProvider: async () => ({ ok: true, value: { provider: stripe } }) }));
const { captureHeldCards } = await import("./tip-capture");
const intents = new Map<string, ProviderPayment>();
const stripe = {
  code: "stripe",
  getPaymentStatus: vi.fn(async (id: string) => ({ ...intents.get(id)! })),
  createSavedCardIntent: vi.fn(async (input: { amountCents: number }) => {
    const id = `pi_tip_${randomUUID()}`;
    const tip = { providerPaymentId: id, status: "pending" as const, providerStatus: "requires_confirmation", amountCents: input.amountCents, cardBrand: "visa", cardLast4: "3289", receiptUrl: null, failureReason: null };
    intents.set(id, tip); return { ...tip };
  }),
  confirmSavedCardIntent: vi.fn(async (id: string) => {
    Object.assign(intents.get(id)!, { status: "captured", providerStatus: "succeeded" }); return { ...intents.get(id)! };
  }),
  capturePayment: vi.fn(async (id: string, input: { amountCents: number }) => {
    Object.assign(intents.get(id)!, { status: "captured", providerStatus: "succeeded", amountCents: input.amountCents }); return { ...intents.get(id)! };
  }),
  releaseHold: vi.fn(),
};

describe("live Order #36 acceptance through durable receipts", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  beforeAll(async () => { db = await startTipPostgres(); }, 120_000);
  afterAll(async () => { await db?.stop(); });
  afterEach(async () => { await db.closeTestClients(); });
  beforeEach(() => { vi.clearAllMocks(); intents.clear(); });
  async function fixture(legacyTip = false) {
    const f = await db.fixture();
    // Exact amounts from Order #36, using only synthetic local records.
    await db.admin.query("update public.payments set amount_cents=4603 where id=$1", [f.paymentId]);
    await db.admin.query("update public.orders set subtotal_cents=4603,total_cents=4603,tax_cents=0,daily_number=36 where id=$1", [f.orderId]);
    intents.set(f.originalId, { providerPaymentId: f.originalId, status: "authorized", providerStatus: "requires_capture", amountCents: 4603, maxCapturableCents: 4603, paymentMethodId: "pm_keyed", customerId: "cus_keyed", cardBrand: "visa", cardLast4: "3289", receiptUrl: null, failureReason: null });
    const tipId = `pi_legacy_${randomUUID()}`;
    if (legacyTip) {
      intents.set(tipId, { providerPaymentId: tipId, status: "captured", providerStatus: "succeeded", amountCents: 300, cardBrand: "visa", cardLast4: "3289", receiptUrl: null, failureReason: null });
      await db.admin.query("update public.payments set metadata=metadata||$2::jsonb where id=$1", [f.paymentId, JSON.stringify({ tip_charge_intent: tipId, tip_charge_cents: 300, tip_charged_separately: true })]);
    }
    const run = async (tip = 300) => captureHeldCards({ service: (await db.service()).api, workspaceId, locationId: null, requests: [{ order_id: f.orderId, tip_cents: tip }], keyPrefix: "driver-cashout" });
    return { ...f, run, tipId };
  }
  it("#36 charges $3 then $46.03, never $49.03, and saves both identities without a warning", async () => {
    const f = await fixture(); const r = await f.run();
    expect(stripe.createSavedCardIntent.mock.calls.map(([i]) => i.amountCents)).toEqual([300]);
    expect(stripe.capturePayment).toHaveBeenCalledWith(f.originalId, expect.objectContaining({ amountCents: 4603 }));
    expect(stripe.confirmSavedCardIntent.mock.invocationCallOrder[0]).toBeLessThan(stripe.capturePayment.mock.invocationCallOrder[0]);
    expect(stripe.releaseHold).not.toHaveBeenCalled(); expect(r.problems).toEqual([]);
    expect(r.captures[0]).toMatchObject({ captured_cents: 4903, tip_cents: 300 });
    const p = (await db.admin.query("select metadata from public.payments where id=$1", [f.paymentId])).rows[0];
    expect(p.metadata).toMatchObject({ tip_charge_cents: 300, tip_charged_separately: true });
    expect(p.metadata.tip_charge_intent).toBe(stripe.confirmSavedCardIntent.mock.calls[0][0]);
  });
  it("declined tip leaves the order held and returns a definite cashier message", async () => {
    const f = await fixture();
    stripe.confirmSavedCardIntent.mockImplementationOnce(async id => { Object.assign(intents.get(id)!, { status: "failed", providerStatus: "requires_payment_method" }); return { ...intents.get(id)! }; });
    const r = await f.run(); expect(stripe.capturePayment).not.toHaveBeenCalled(); expect(r.captures).toEqual([]);
    expect(r.problems[0]).toMatch(/#\d+: Stripe declined the \$3\.00 tip\. Nothing was charged/);
  });
  it("unknown tip confirmation holds the order and retries the bound identity", async () => {
    const f = await fixture();
    stripe.confirmSavedCardIntent.mockRejectedValueOnce(new Error("Network timeout"));
    expect((await f.run()).captures).toEqual([]); expect(stripe.capturePayment).not.toHaveBeenCalled();
    await f.run(); expect(stripe.createSavedCardIntent).toHaveBeenCalledTimes(1);
    const keys = stripe.confirmSavedCardIntent.mock.calls.map(([id]) => id); expect(new Set(keys).size).toBe(1);
  });
  it("adopts a previously charged $3 tip without charging it again", async () => {
    const f = await fixture(true); const r = await f.run();
    expect(stripe.createSavedCardIntent).not.toHaveBeenCalled(); expect(stripe.confirmSavedCardIntent).not.toHaveBeenCalled();
    expect(r.captures[0]).toMatchObject({ captured_cents: 4903, tip_cents: 300 });
  });
  it("changed tip, including zero, never changes an already charged $3 tip or charges it again", async () => {
    const f = await fixture(true); const r = await f.run(500); const zero = await f.run(0);
    expect(stripe.createSavedCardIntent).not.toHaveBeenCalled(); expect(stripe.confirmSavedCardIntent).not.toHaveBeenCalled();
    expect(r.problems.join(" ")).toMatch(/\$3\.00 tip was already charged/);
    expect(zero.problems.join(" ")).toMatch(/\$3\.00 tip was already charged/);
    expect(stripe.capturePayment).not.toHaveBeenCalled();
  });
  it("recovers an order capture whose successful answer was lost without another tip or capture", async () => {
    const f = await fixture(); const capture = stripe.capturePayment.getMockImplementation()!;
    stripe.capturePayment.mockImplementationOnce(async (id,input) => { await capture(id,input); throw new Error("Lost answer"); });
    expect((await f.run()).captures[0]).toMatchObject({ captured_cents: 4903, tip_cents: 300 });
    await f.run(); expect(stripe.capturePayment).toHaveBeenCalledTimes(1); expect(stripe.confirmSavedCardIntent).toHaveBeenCalledTimes(1);
  });
  it("zero tip captures only the original authorization", async () => {
    const f = await fixture(); expect((await f.run(0)).captures[0]).toMatchObject({ captured_cents: 4603, tip_cents: 0 });
    expect(stripe.createSavedCardIntent).not.toHaveBeenCalled(); expect(stripe.capturePayment.mock.calls[0][1].amountCents).toBe(4603);
  });
  it("M2 with sufficient room captures order and tip on the original authorization", async () => {
    const f = await fixture(); intents.get(f.originalId)!.maxCapturableCents = 9603;
    expect((await f.run()).captures[0]).toMatchObject({ captured_cents: 4903, tip_cents: 300 });
    expect(stripe.createSavedCardIntent).not.toHaveBeenCalled(); expect(stripe.capturePayment.mock.calls[0][1].amountCents).toBe(4903);
  });
});
