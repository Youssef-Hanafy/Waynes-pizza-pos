import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureHeldCards } from "@/lib/payments/tip-capture";
import { PaymentProviderError, type ProviderPayment } from "@/lib/payments/provider";
import { startTipPostgres, ownerId, workspaceId } from "./helpers/tip-postgres";

/**
 * Independent verification of the delivery tip-before-payment release (Issue #5,
 * ef24ec9) on real PostgreSQL: concurrent registers, lost Stripe answers, retries,
 * the nightly safety-net capture, declines, Tips/cash-out races and refunds of a
 * payment that holds a phone tip.  Every test checks the money: what Stripe
 * charged == what the payment says == what the order says, and the driver is paid
 * the order's tip exactly once.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/payments/config", () => ({ resolvePaymentProvider: async () => ({ ok: true, value: { provider } }) }));

const intents = new Map<string, ProviderPayment>();
let charges: Array<{ id: string; cents: number }> = [];
let loseCaptureAnswer = false;
let declineNextTip = false;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const provider = {
  code: "stripe",
  getPaymentStatus: vi.fn(async (id: string) => ({ ...intents.get(id)! })),
  createSavedCardIntent: vi.fn(async (input: { amountCents: number }) => {
    await pause(15);
    const id = `pi_tip_${randomUUID().replaceAll("-", "")}`;
    const result: ProviderPayment = { providerPaymentId: id, status: "pending", providerStatus: "requires_confirmation", amountCents: input.amountCents, cardBrand: "visa", cardLast4: "4242", receiptUrl: null, failureReason: null };
    intents.set(id, result);
    return result;
  }),
  confirmSavedCardIntent: vi.fn(async (id: string) => {
    await pause(15);
    if (declineNextTip) {
      declineNextTip = false;
      const declined = { ...intents.get(id)!, status: "failed" as const, providerStatus: "requires_payment_method" };
      intents.set(id, declined);
      return declined;
    }
    const result = { ...intents.get(id)!, status: "captured" as const, providerStatus: "succeeded" };
    if (intents.get(id)?.status !== "captured") charges.push({ id, cents: result.amountCents! });
    intents.set(id, result);
    return result;
  }),
  capturePayment: vi.fn(async (id: string, input: { amountCents: number }) => {
    await pause(15);
    const result = { ...intents.get(id)!, status: "captured" as const, providerStatus: "succeeded", amountCents: input.amountCents };
    if (intents.get(id)?.status !== "captured") charges.push({ id, cents: input.amountCents });
    intents.set(id, result);
    if (loseCaptureAnswer) { loseCaptureAnswer = false; throw new PaymentProviderError("Lost Stripe response", "NETWORK", true); }
    return result;
  }),
  voidPayment: vi.fn(async (id: string) => { const result = { ...intents.get(id)!, status: "voided" as const, providerStatus: "canceled" }; intents.set(id, result); return result; }),
  releaseHold: vi.fn(async (id: string) => { const result = { ...intents.get(id)!, status: "voided" as const, providerStatus: "canceled" }; intents.set(id, result); return result; }),
};

describe("delivery tip before payment — adversarial verification", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  const driverId = "79000000-0000-4000-8000-0000000000d2";
  beforeAll(async () => {
    db = await startTipPostgres();
    await db.admin.query(`insert into auth.users(id,email,raw_user_meta_data) values('${driverId}','driver2@tip-before.test','{"display_name":"Dina"}');
      update public.profiles set active=true, display_name='Dina' where id='${driverId}';`);
  }, 180_000);
  afterAll(async () => { await db?.stop(); });
  afterEach(async () => { await db.closeTestClients(); });
  beforeEach(() => { intents.clear(); charges = []; loseCaptureAnswer = false; declineNextTip = false; vi.clearAllMocks(); });

  /** A register: its own PostgreSQL backend, signed in as the owner (PostgREST's authenticated role). */
  async function register() {
    const client = await db.connect();
    const call = async <T>(sql: string, params: unknown[] = []): Promise<T> => {
      await client.query(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${ownerId}',true);`);
      try { const result = await client.query(sql, params); await client.query("commit"); return result.rows[0]?.value as T; }
      catch (error) { await client.query("rollback"); throw error; }
    };
    return {
      setTip: (orderId: string, cents: number) => call<{ tip_cents: number; total_cents: number }>("select public.wayne_pos_set_tip($1::uuid,$2::integer) value", [orderId, cents]),
      begin: (orderId: string, key = `pos-keyed-card-${orderId}-${randomUUID()}`) => call<{ payment_id: string; amount_cents: number; duplicate: boolean }>("select public.wayne_begin_payment($1::jsonb) value",
        [JSON.stringify({ order_id: orderId, idempotency_key: key, entry: "pos_keyed_card", method: "card" })]),
      call,
    };
  }
  async function deliveryOrder() {
    const id = randomUUID();
    await db.admin.query(`insert into public.orders(id, order_number, source, fulfillment_type, status, payment_status, payment_method, customer_name_snapshot, customer_phone_snapshot,
        delivery_address_snapshot, placed_at, idempotency_key, pricing_snapshot, subtotal_cents, delivery_fee_cents, tax_cents, total_cents)
      values($1, $2, 'phone', 'delivery', 'out_for_delivery', 'unpaid', 'card', 'Pat', '5085550144',
        '{"address1":"10 Main St","city":"Worcester","state":"MA","postal_code":"01606"}'::jsonb, now(), $3, '{}'::jsonb, 2500, 200, 300, 3000)`,
      [id, `TA-${id.slice(0, 8)}`, `tip-adv-${id}`]);
    return id;
  }
  async function approve(paymentId: string) {
    const row = (await db.admin.query("select p.amount_cents, o.tip_cents, o.total_cents from public.payments p join public.orders o on o.id=p.order_id where p.id=$1", [paymentId])).rows[0];
    const tipIncluded = row.total_cents === row.amount_cents ? row.tip_cents : 0;
    const intentId = `pi_keyed_${paymentId.replaceAll("-", "")}`;
    intents.set(intentId, { providerPaymentId: intentId, status: "authorized", providerStatus: "requires_capture", amountCents: row.amount_cents, maxCapturableCents: row.amount_cents, customerId: "cus_test", paymentMethodId: "pm_test", cardBrand: "visa", cardLast4: "4242", receiptUrl: null, failureReason: null });
    await db.admin.query("update public.payments set provider_payment_id=$2, provider='stripe', metadata=metadata||$3::jsonb where id=$1",
      [paymentId, intentId, JSON.stringify({ tip_adjust: true, held_for: "delivery_tip", ...(tipIncluded ? { tip_included_cents: tipIncluded, order_cents: row.amount_cents - tipIncluded } : {}) })]);
    const { api } = await db.service();
    const settled = await api.rpc("wayne_settle_payment", { payload: { payment_id: paymentId, status: "authorized", provider_payment_id: intentId, amount_cents: row.amount_cents, card_brand: "visa", card_last4: "4242", metadata: { source: "pos_keyed_card", tip_adjust: true } } });
    expect(settled.error).toBeNull();
    return intentId;
  }
  async function preTipped(tip = 500) {
    const reg = await register();
    const orderId = await deliveryOrder();
    await reg.setTip(orderId, tip);
    const begun = await reg.begin(orderId);
    const intentId = await approve(begun.payment_id);
    return { orderId, paymentId: begun.payment_id, intentId };
  }
  async function capture(orderId: string, extra: number, keyPrefix: string) {
    const { api } = await db.service();
    return captureHeldCards({ service: api, workspaceId, locationId: null, requests: [{ order_id: orderId, tip_cents: extra }], keyPrefix });
  }
  async function money(orderId: string) {
    const row = (await db.admin.query(`select o.tip_cents, o.total_cents, p.amount_cents, p.status, p.metadata from public.orders o join public.payments p on p.order_id=o.id
      where o.id=$1 and p.status in ('authorized','captured') order by p.created_at desc limit 1`, [orderId])).rows[0];
    const charged = charges.reduce((sum, charge) => sum + charge.cents, 0);
    return { ...row, charged };
  }

  describe("two registers on the same order", () => {
    it("tip change racing the approval never leaves an approval whose amount differs from the order", async () => {
      for (let round = 0; round < 12; round += 1) {
        const orderId = await deliveryOrder();
        const a = await register(), b = await register();
        await a.setTip(orderId, 500);
        const results = await Promise.allSettled([a.begin(orderId), b.setTip(orderId, 800 + round)]);
        const order = (await db.admin.query("select total_cents, tip_cents from public.orders where id=$1", [orderId])).rows[0];
        const open = (await db.admin.query("select amount_cents from public.payments where order_id=$1 and status='pending'", [orderId])).rows;
        expect(open.length).toBeLessThanOrEqual(1);
        if (open.length) expect(open[0].amount_cents).toBe(order.total_cents);
        // Exactly one of the two orderings: tip changed first (approval for the new total) or approval first (tip refused).
        if (results[1].status === "rejected") expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/amount is locked/);
        await db.closeTestClients();
      }
    });

    it("both registers pressing Approve at once open exactly one payment", async () => {
      const orderId = await deliveryOrder();
      const a = await register(), b = await register();
      await a.setTip(orderId, 500);
      const results = await Promise.allSettled([a.begin(orderId), b.begin(orderId)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)).toMatch(/already open/);
      expect((await db.admin.query("select count(*)::int n, max(amount_cents) amount from public.payments where order_id=$1", [orderId])).rows[0]).toEqual({ n: 1, amount: 3500 });
    });
  });

  describe("lost answers and retries", () => {
    it("a register whose approval request lost its answer can re-save the SAME tip (no-op) but not change it", async () => {
      const orderId = await deliveryOrder();
      const reg = await register();
      await reg.setTip(orderId, 500);
      await reg.begin(orderId); // the response never reached the register
      // The register retries: it re-sends the tip it shows ($5) before asking for the approval again.
      expect(await reg.setTip(orderId, 500)).toEqual({ tip_cents: 500, total_cents: 3500 });
      await expect(reg.setTip(orderId, 700)).rejects.toThrow(/amount is locked/);
      // And it can't open a second approval beside the first.
      await expect(reg.begin(orderId)).rejects.toThrow(/already open/);
      expect((await db.admin.query("select total_cents from public.orders where id=$1", [orderId])).rows[0].total_cents).toBe(3500);
    });

    it("a replayed approval request (same key) returns the same payment and never a second one", async () => {
      const orderId = await deliveryOrder();
      const reg = await register();
      await reg.setTip(orderId, 500);
      const key = `pos-keyed-card-${orderId}-${randomUUID()}`;
      const first = await reg.begin(orderId, key);
      const replay = await reg.begin(orderId, key);
      expect(replay).toMatchObject({ payment_id: first.payment_id, duplicate: true });
      expect((await db.admin.query("select count(*)::int n from public.payments where order_id=$1", [orderId])).rows[0].n).toBe(1);
    });

    it("a lost Stripe capture answer at cash-out is read back from Stripe, and a retry moves no more money", async () => {
      const { orderId, intentId } = await preTipped();
      loseCaptureAnswer = true;
      // The coordinator reads the capture back from Stripe instead of trusting the lost answer.
      expect((await capture(orderId, 0, "driver-cashout")).captures[0]).toMatchObject({ captured_cents: 3500, tip_cents: 0 });
      const retried = await capture(orderId, 0, "driver-cashout");
      expect(retried.captures[0]).toMatchObject({ captured_cents: 3500, tip_cents: 0 });
      expect(charges).toEqual([{ id: intentId, cents: 3500 }]);
      expect(await money(orderId)).toMatchObject({ tip_cents: 500, total_cents: 3500, amount_cents: 3500, status: "captured", charged: 3500 });
    });
  });

  describe("the other capture paths", () => {
    it("the 4:30 am safety net captures a pre-tipped card for its $35 and keeps the $5 tip", async () => {
      const { orderId, intentId } = await preTipped();
      const result = await capture(orderId, 0, "auto");
      expect(result.captures[0]).toMatchObject({ captured_cents: 3500, tip_cents: 0 });
      expect(charges).toEqual([{ id: intentId, cents: 3500 }]);
      expect(await money(orderId)).toMatchObject({ tip_cents: 500, total_cents: 3500, amount_cents: 3500, charged: 3500 });
    });

    it("Tips, driver cash-out and the safety net racing on one pre-tipped card: one money movement set, ledger exact", async () => {
      const { orderId } = await preTipped();
      await Promise.all([capture(orderId, 300, "driver-cashout"), capture(orderId, 0, "tips"), capture(orderId, 0, "auto")]);
      const op = (await db.admin.query("select o.result from public.pos_tip_operations o join public.payments p on p.id=o.payment_id where p.order_id=$1", [orderId])).rows;
      expect(op).toHaveLength(1);
      const ledger = await money(orderId);
      expect(ledger.charged).toBe(ledger.amount_cents);
      expect(ledger.total_cents).toBe(ledger.amount_cents);
      expect(ledger.tip_cents).toBe(500 + op[0].result.tip_cents);
      expect([3500, 3800]).toContain(ledger.amount_cents);
    });

    it("an extra tip Stripe declines after the approval: nothing charged, order still held; then $0 extra charges the $35 only", async () => {
      const { orderId, intentId } = await preTipped();
      declineNextTip = true;
      const declined = await capture(orderId, 300, "driver-cashout");
      expect(declined.captures).toHaveLength(0);
      expect(declined.problems.join(" ")).toMatch(/declined the \$3\.00 tip/);
      expect(charges).toEqual([]);
      expect((await money(orderId)).status).toBe("authorized");
      const settled = await capture(orderId, 0, "driver-cashout");
      expect(settled.captures[0]).toMatchObject({ captured_cents: 3500, tip_cents: 0 });
      expect(charges).toEqual([{ id: intentId, cents: 3500 }]);
      expect(await money(orderId)).toMatchObject({ tip_cents: 500, total_cents: 3500, amount_cents: 3500, charged: 3500 });
    });
  });

  describe("refunds of a payment that holds a phone tip", () => {
    async function refund(f: { orderId: string; paymentId: string }, amount: number, tip: number) {
      const reg = await register();
      return reg.call<{ legs: Array<{ amount_cents: number; tip_cents: number; provider_payment_id: string }> }>("select public.wayne_begin_allocated_refund($1::jsonb) value",
        [JSON.stringify({ payment_id: f.paymentId, order_id: f.orderId, amount_cents: amount, tip_cents: tip, reason: "Verification refund", idempotency_key: randomUUID() })]);
    }

    it("$35 approval with the $5 phone tip, captured: a full refund is one leg on that one charge", async () => {
      const f = await preTipped();
      await capture(f.orderId, 0, "driver-cashout");
      const result = await refund(f, 3500, 500);
      expect(result.legs).toEqual([expect.objectContaining({ amount_cents: 3500, tip_cents: 500, provider_payment_id: f.intentId })]);
    });

    it("$5 phone tip + $3 extra charged on its own: no refund leg is ever larger than the Stripe charge it refunds", async () => {
      const f = await preTipped();
      await capture(f.orderId, 300, "driver-cashout");
      const tipIntent = charges.find((charge) => charge.id !== f.intentId)!;
      expect(tipIntent.cents).toBe(300);
      const result = await refund(f, 3800, 800);
      const byIntent = new Map<string, number>();
      for (const leg of result.legs) byIntent.set(leg.provider_payment_id, (byIntent.get(leg.provider_payment_id) ?? 0) + leg.amount_cents);
      expect(byIntent.get(f.intentId)).toBe(3500);
      expect(byIntent.get(tipIntent.id)).toBe(300);
      expect(result.legs.reduce((sum, leg) => sum + leg.amount_cents, 0)).toBe(3800);
      expect(result.legs.reduce((sum, leg) => sum + leg.tip_cents, 0)).toBe(800);
    });

    it("a tip-only refund of the $5 phone tip comes off the original $35 charge, not the $3 extra", async () => {
      const f = await preTipped();
      await capture(f.orderId, 300, "driver-cashout");
      const tipIntent = charges.find((charge) => charge.id !== f.intentId)!;
      const first = await refund(f, 300, 300);
      expect(first.legs).toEqual([expect.objectContaining({ amount_cents: 300, tip_cents: 300, provider_payment_id: tipIntent.id })]);
      const second = await refund(f, 500, 500);
      expect(second.legs).toEqual([expect.objectContaining({ amount_cents: 500, tip_cents: 500, provider_payment_id: f.intentId })]);
    });
  });
});
