import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureHeldCards } from "@/lib/payments/tip-capture";
import type { ProviderPayment } from "@/lib/payments/provider";
import { startTipPostgres, ownerId, workspaceId } from "./helpers/tip-postgres";

/**
 * Delivery tip BEFORE payment (owner, 2026-10-31), on the full migration chain in a
 * real PostgreSQL cluster:
 *
 *   $30 delivery + $5 phone tip → the order holds the tip → ONE $35 approval →
 *   driver cash-out charges nothing more, pays the driver $5 from the drawer.
 *
 * And the two workflows stay apart: a tip from the signed slip AFTER the approval
 * goes through the existing durable tip operation, which charges only the extra.
 */
vi.mock("server-only", () => ({}));
vi.mock("@/lib/payments/config", () => ({ resolvePaymentProvider: async () => ({ ok: true, value: { provider } }) }));

const intents = new Map<string, ProviderPayment>();
let charges: Array<{ id: string; cents: number }> = [];
const provider = {
  code: "stripe",
  getPaymentStatus: vi.fn(async (id: string) => ({ ...intents.get(id)! })),
  createSavedCardIntent: vi.fn(async (input: { amountCents: number }) => {
    const id = `pi_tip_${randomUUID().replaceAll("-", "")}`;
    const result: ProviderPayment = { providerPaymentId: id, status: "pending", providerStatus: "requires_confirmation", amountCents: input.amountCents, cardBrand: "visa", cardLast4: "4242", receiptUrl: null, failureReason: null };
    intents.set(id, result);
    return result;
  }),
  confirmSavedCardIntent: vi.fn(async (id: string) => {
    const result = { ...intents.get(id)!, status: "captured" as const, providerStatus: "succeeded" };
    charges.push({ id, cents: result.amountCents! });
    intents.set(id, result);
    return result;
  }),
  capturePayment: vi.fn(async (id: string, input: { amountCents: number }) => {
    const result = { ...intents.get(id)!, status: "captured" as const, providerStatus: "succeeded", amountCents: input.amountCents };
    if (intents.get(id)?.status !== "captured") charges.push({ id, cents: input.amountCents });
    intents.set(id, result);
    return result;
  }),
  voidPayment: vi.fn(async (id: string) => { const result = { ...intents.get(id)!, status: "voided" as const, providerStatus: "canceled" }; intents.set(id, result); return result; }),
  releaseHold: vi.fn(async (id: string) => { const result = { ...intents.get(id)!, status: "voided" as const, providerStatus: "canceled" }; intents.set(id, result); return result; }),
};

describe("delivery tip before payment (keyed card, one combined approval)", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  const driverId = "79000000-0000-4000-8000-0000000000d1";
  beforeAll(async () => {
    db = await startTipPostgres();
    await db.admin.query(`insert into auth.users(id,email,raw_user_meta_data) values('${driverId}','driver@tip-before.test','{"display_name":"Dave"}');
      update public.profiles set active=true, display_name='Dave' where id='${driverId}';`);
  }, 180_000);
  afterAll(async () => { await db?.stop(); });
  afterEach(async () => { await db.closeTestClients(); });
  beforeEach(() => { intents.clear(); charges = []; vi.clearAllMocks(); });

  /** Runs SQL as the signed-in owner on the POS (PostgREST's authenticated role). */
  async function asOwner<T>(sql: string, params: unknown[] = []): Promise<T> {
    await db.admin.query(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${ownerId}',true);`);
    try {
      const result = await db.admin.query(sql, params);
      await db.admin.query("commit");
      return result.rows[0]?.value as T;
    } catch (error) {
      await db.admin.query("rollback");
      throw error;
    }
  }
  const setTip = (orderId: string, cents: number) => asOwner<{ tip_cents: number; total_cents: number }>("select public.wayne_pos_set_tip($1::uuid,$2::integer) value", [orderId, cents]);
  const begin = (orderId: string) => asOwner<{ payment_id: string; amount_cents: number; duplicate: boolean }>("select public.wayne_begin_payment($1::jsonb) value",
    [JSON.stringify({ order_id: orderId, idempotency_key: `pos-keyed-card-${orderId}-${randomUUID()}`, entry: "pos_keyed_card", method: "card" })]);

  /** A $30.00 phone delivery ($25 food + $2 delivery + $3 tax), out with the driver, not paid yet. */
  async function deliveryOrder() {
    const id = randomUUID();
    await db.admin.query(`insert into public.orders(id, order_number, source, fulfillment_type, status, payment_status, payment_method, customer_name_snapshot, customer_phone_snapshot,
        delivery_address_snapshot, placed_at, idempotency_key, pricing_snapshot, subtotal_cents, delivery_fee_cents, tax_cents, total_cents)
      values($1, $2, 'phone', 'delivery', 'out_for_delivery', 'unpaid', 'card', 'Pat', '5085550144',
        '{"address1":"10 Main St","city":"Worcester","state":"MA","postal_code":"01606"}'::jsonb, now(), $3, '{}'::jsonb, 2500, 200, 300, 3000)`,
      [id, `TB-${id.slice(0, 8)}`, `tip-before-${id}`]);
    return id;
  }
  /** Stripe approves the keyed card for exactly what the payment asked (no overcapture on keyed cards). */
  async function approve(paymentId: string, tipIncluded: number) {
    const row = (await db.admin.query("select amount_cents from public.payments where id=$1", [paymentId])).rows[0];
    const intentId = `pi_keyed_${paymentId.replaceAll("-", "")}`;
    intents.set(intentId, { providerPaymentId: intentId, status: "authorized", providerStatus: "requires_capture", amountCents: row.amount_cents, maxCapturableCents: row.amount_cents, customerId: "cus_test", paymentMethodId: "pm_test", cardBrand: "visa", cardLast4: "4242", receiptUrl: null, failureReason: null });
    // What /api/pos/keyed-card/intent and /confirm write for a delivery card.
    await db.admin.query("update public.payments set provider_payment_id=$2, provider='stripe', metadata=metadata||$3::jsonb where id=$1",
      [paymentId, intentId, JSON.stringify({ tip_adjust: true, held_for: "delivery_tip", ...(tipIncluded ? { tip_included_cents: tipIncluded, order_cents: row.amount_cents - tipIncluded } : {}) })]);
    const { api } = await db.service();
    const settled = await api.rpc("wayne_settle_payment", { payload: { payment_id: paymentId, status: "authorized", provider_payment_id: intentId, amount_cents: row.amount_cents, card_brand: "visa", card_last4: "4242", metadata: { source: "pos_keyed_card", tip_adjust: true } } });
    expect(settled.error).toBeNull();
    return intentId;
  }
  async function assign(orderId: string) {
    await db.admin.query("insert into public.delivery_assignments(order_id, driver_id, status, picked_up_at) values($1,$2,'picked_up',now())", [orderId, driverId]);
  }
  /** Driver cash-out exactly as /api/pos/delivery/cashout runs it: capture the held cards, then record the cash-out. */
  async function cashOut(orderId: string, extraTip: number) {
    const { api } = await db.service();
    const captured = await captureHeldCards({ service: api, workspaceId, locationId: null, requests: [{ order_id: orderId, tip_cents: extraTip }], keyPrefix: "driver-cashout" });
    expect(captured.skipped).toEqual([]);
    const cashout = await asOwner<{ card_tips_cents: number; hand_in_cents: number; detail: Array<{ tip_cents: number; total_cents: number; paid_by: string }> }>(
      "select public.wayne_pos_driver_cashout($1::uuid,$2::jsonb,$3::jsonb,'[]'::jsonb,'') value",
      [driverId, JSON.stringify([{ order_id: orderId, tip_cents: extraTip }]), JSON.stringify(captured.captures)]);
    return { captured, cashout };
  }
  const ledger = async (orderId: string) => (await db.admin.query(
    `select o.tip_cents, o.total_cents, o.payment_status, p.amount_cents, p.status, p.metadata,
       (select a.tip_cents from public.delivery_assignments a where a.order_id=o.id) as driver_tip
     from public.orders o join public.payments p on p.order_id=o.id where o.id=$1 order by p.created_at desc limit 1`, [orderId])).rows[0];

  it("$30 order + $5 tip on the phone: the order holds the tip and ONE payment is opened for $35", async () => {
    const orderId = await deliveryOrder();
    expect(await setTip(orderId, 500)).toEqual({ tip_cents: 500, total_cents: 3500 });
    const begun = await begin(orderId);
    expect(begun.amount_cents).toBe(3500);
    expect((await db.admin.query("select count(*)::int n from public.payments where order_id=$1", [orderId])).rows[0].n).toBe(1);
  });

  it("locks the tip once the approval has begun, and unlocks it after a definite decline", async () => {
    const orderId = await deliveryOrder();
    await setTip(orderId, 500);
    const first = await begin(orderId);
    // Pending approval: the amount Stripe was asked for can't drift from the order.
    await expect(setTip(orderId, 800)).rejects.toThrow(/amount is locked/);
    expect((await ledger(orderId)).total_cents).toBe(3500);
    // A second approval can't start beside it either.
    await expect(begin(orderId)).rejects.toThrow(/already open/);
    // Stripe declined: the attempt is closed, the tip can change before the next card.
    const { api } = await db.service();
    expect((await api.rpc("wayne_settle_payment", { payload: { payment_id: first.payment_id, status: "failed", failure_reason: "declined" } })).error).toBeNull();
    expect(await setTip(orderId, 800)).toEqual({ tip_cents: 800, total_cents: 3800 });
    expect((await begin(orderId)).amount_cents).toBe(3800);
  });

  it("refuses a tip change after the card is approved (that is the cash-out's job)", async () => {
    const orderId = await deliveryOrder();
    await setTip(orderId, 500);
    await approve((await begin(orderId)).payment_id, 500);
    await expect(setTip(orderId, 700)).rejects.toThrow(/already on this order/);
  });

  it("driver cash-out with no extra tip: captures the $35 approval once and pays the driver the $5 — never charged again", async () => {
    const orderId = await deliveryOrder();
    await setTip(orderId, 500);
    const intentId = await approve((await begin(orderId)).payment_id, 500);
    await assign(orderId);
    const { captured, cashout } = await cashOut(orderId, 0);
    expect(charges).toEqual([{ id: intentId, cents: 3500 }]);
    expect(provider.createSavedCardIntent).not.toHaveBeenCalled();
    expect(captured.captures[0]).toMatchObject({ captured_cents: 3500, tip_cents: 0 });
    const row = await ledger(orderId);
    expect(row).toMatchObject({ tip_cents: 500, total_cents: 3500, payment_status: "paid", amount_cents: 3500, status: "captured", driver_tip: 500 });
    expect(row.metadata.tip_included_cents).toBe(500);
    expect(cashout.card_tips_cents).toBe(500);
    expect(cashout.detail[0]).toMatchObject({ tip_cents: 500, total_cents: 3500 });
    // The drawer pays the driver the phone tip exactly once.
    const paidOut = (await db.admin.query("select coalesce(sum(amount_cents),0)::int n from public.cash_movements where kind='paid_out' and reason like 'Driver tips%' and created_at > now() - interval '1 minute'")).rows[0].n;
    expect(paidOut).toBeGreaterThanOrEqual(500);
    // Running the cash-out capture again (double tap / retry) moves no more money.
    const { api } = await db.service();
    const again = await captureHeldCards({ service: api, workspaceId, locationId: null, requests: [{ order_id: orderId, tip_cents: 0 }], keyPrefix: "driver-cashout" });
    // At most the same saved receipt is read back; no new Stripe call moves money.
    expect(again.captures.every((capture) => capture.captured_cents === 3500 && capture.tip_cents === 0)).toBe(true);
    expect(charges).toHaveLength(1);
    expect(provider.capturePayment).toHaveBeenCalledTimes(1);
    expect((await ledger(orderId)).tip_cents).toBe(500);
  });

  it("an extra tip on the signed slip after approval goes through the existing durable tip operation and charges only the extra", async () => {
    const orderId = await deliveryOrder();
    await setTip(orderId, 500);
    const intentId = await approve((await begin(orderId)).payment_id, 500);
    await assign(orderId);
    const { captured, cashout } = await cashOut(orderId, 300);
    // Keyed cards can't be overcaptured: the $3 extra is its own charge, the approval is captured for its $35.
    expect(charges).toHaveLength(2);
    expect(charges).toContainEqual({ id: intentId, cents: 3500 });
    expect(charges.find((charge) => charge.id !== intentId)?.cents).toBe(300);
    expect(captured.captures[0]).toMatchObject({ captured_cents: 3800, tip_cents: 300 });
    expect(await ledger(orderId)).toMatchObject({ tip_cents: 800, total_cents: 3800, amount_cents: 3800, driver_tip: 800 });
    expect(cashout.card_tips_cents).toBe(800);
  });

  it("without a phone tip the delivery cash-out is unchanged: the slip's tip is added at cash-out", async () => {
    const orderId = await deliveryOrder();
    const begun = await begin(orderId);
    expect(begun.amount_cents).toBe(3000);
    const intentId = await approve(begun.payment_id, 0);
    await assign(orderId);
    const { cashout } = await cashOut(orderId, 500);
    expect(charges).toContainEqual({ id: intentId, cents: 3000 });
    expect(charges.reduce((sum, charge) => sum + charge.cents, 0)).toBe(3500);
    expect(await ledger(orderId)).toMatchObject({ tip_cents: 500, total_cents: 3500, driver_tip: 500 });
    expect(cashout.card_tips_cents).toBe(500);
  });

  it("the Deliveries board reads the phone tip on the held card (so the screen can say it's already charged)", async () => {
    const orderId = await deliveryOrder();
    await setTip(orderId, 500);
    await approve((await begin(orderId)).payment_id, 500);
    const view = (await db.admin.query("select public.wayne_pos_delivery_order_json($1) value", [orderId])).rows[0].value;
    expect(view).toMatchObject({ paid_by: "card_held", tip_cents: 500, total_cents: 3500 });
  });
});
