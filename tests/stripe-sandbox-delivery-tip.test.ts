import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureHeldCards } from "@/lib/payments/tip-capture";
import { createStripeProvider } from "@/lib/payments/stripe";
import { reconcileRefundLegs, type RefundLeg } from "@/lib/payments/refund-operation";
import type { PaymentProvider } from "@/lib/payments/provider";
import { startTipPostgres, ownerId, workspaceId } from "./helpers/tip-postgres";

/**
 * REAL Stripe sandbox proof for the delivery tip-before-payment release (Issue #5).
 *
 * Opt-in: runs only with STRIPE_SANDBOX_SECRET_KEY=sk_test_… (or rk_test_…); a live key is refused.
 * The database is a throwaway local PostgreSQL (embedded) with EVERY migration applied — never
 * staging or production.  The POS code paths are the production ones: wayne_pos_set_tip,
 * wayne_begin_payment, the Stripe adapter, wayne_settle_payment, captureHeldCards (the durable tip
 * operation used by the driver cash-out), wayne_pos_driver_cashout, wayne_begin_allocated_refund and
 * reconcileRefundLegs.  Only the card entry differs: Stripe.js is replaced by Stripe's own test
 * payment methods (pm_card_visa, pm_card_chargeDeclined) confirmed server-side.
 */
const key = process.env.STRIPE_SANDBOX_SECRET_KEY ?? "";
const sandbox = /^(sk|rk)_test_/.test(key);
if (key && !sandbox) throw new Error("Refusing to run: STRIPE_SANDBOX_SECRET_KEY must be a Stripe TEST key (sk_test_… / rk_test_…).");

vi.mock("server-only", () => ({}));
vi.mock("@/lib/payments/config", () => ({ resolvePaymentProvider: async () => ({ ok: true, value: { provider: stripeProvider() } }) }));
let cached: PaymentProvider | null = null;
function stripeProvider() { return (cached ??= createStripeProvider({ secretKey: key, webhookSecret: "whsec_unused_in_this_test" })); }

async function stripe<T = Record<string, unknown>>(path: string, body?: Record<string, string>) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: body ? new URLSearchParams(body) : undefined,
  });
  return { status: response.status, json: await response.json() as T };
}
type Intent = { id: string; status: string; amount: number; amount_received: number; amount_capturable: number; customer: string | null; metadata: Record<string, string>; latest_charge: string | null };
type Charge = { id: string; amount: number; amount_captured: number; amount_refunded: number; captured: boolean; paid: boolean; status: string; payment_intent: string };

describe.skipIf(!sandbox)("Stripe SANDBOX: delivery tip before payment ($30 + $5 → one $35 approval)", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  const driverId = "79000000-0000-4000-8000-0000000000d9";
  const run = randomUUID().slice(0, 8);
  beforeAll(async () => {
    db = await startTipPostgres();
    // Both release migrations are re-runnable: apply them a second time on top of the full chain.
    for (const file of ["20261122080000_delivery_tip_before_payment.sql", "20261123080000_delivery_tip_verification_fixes.sql"]) {
      await db.admin.query(await readFile(`supabase/migrations/${file}`, "utf8"));
    }
    await db.admin.query(`insert into auth.users(id,email,raw_user_meta_data) values('${driverId}','sandbox-driver@tip.test','{"display_name":"Sandbox Driver"}');
      update public.profiles set active=true, display_name='Sandbox Driver' where id='${driverId}';`);
  }, 240_000);
  afterAll(async () => { await db?.stop(); });

  async function asOwner<T>(sql: string, params: unknown[] = []): Promise<T> {
    const client = await db.connect();
    await client.query(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${ownerId}',true);`);
    try { const result = await client.query(sql, params); await client.query("commit"); return result.rows[0]?.value as T; }
    catch (error) { await client.query("rollback"); throw error; }
    finally { await client.end(); }
  }
  async function deliveryOrder() {
    const id = randomUUID();
    await db.admin.query(`insert into public.orders(id, order_number, source, fulfillment_type, status, payment_status, payment_method, customer_name_snapshot, customer_phone_snapshot,
        delivery_address_snapshot, placed_at, idempotency_key, pricing_snapshot, subtotal_cents, delivery_fee_cents, tax_cents, total_cents)
      values($1, $2, 'phone', 'delivery', 'out_for_delivery', 'unpaid', 'card', 'Sandbox Customer', '5085550199',
        '{"address1":"93 West Boylston St","city":"Worcester","state":"MA","postal_code":"01606"}'::jsonb, now(), $3, '{}'::jsonb, 2500, 200, 300, 3000)`,
      [id, `SBX-${run}-${id.slice(0, 4)}`, `sandbox-${id}`]);
    return id;
  }
  /** Exactly what /api/pos/keyed-card/intent + Stripe.js + /api/pos/keyed-card/confirm do, with a Stripe test card. */
  async function keyCard(orderId: string, tipCents: number, paymentMethod: string) {
    await asOwner("select public.wayne_pos_set_tip($1::uuid,$2::integer) value", [orderId, tipCents]);
    const idempotencyKey = `pos-keyed-card-${orderId}-${randomUUID()}`;
    const begun = await asOwner<{ payment_id: string; amount_cents: number; order_number: string }>("select public.wayne_begin_payment($1::jsonb) value",
      [JSON.stringify({ order_id: orderId, idempotency_key: idempotencyKey, entry: "pos_keyed_card", method: "card" })]);
    const intent = await stripeProvider().createOnlinePaymentIntent({
      amountCents: begun.amount_cents, idempotencyKey, referenceId: begun.order_number, paymentId: begun.payment_id, receiptEmail: null,
      note: `Sandbox order ${begun.order_number} (keyed card — order + ${tipCents} tip)`, tipAdjust: true, tipCents,
    });
    await db.admin.query("update public.payments set provider_payment_id=$2, provider='stripe', metadata=metadata||$3::jsonb where id=$1",
      [begun.payment_id, intent.providerPaymentId, JSON.stringify({ tip_adjust: true, held_for: "delivery_tip", ...(tipCents ? { tip_included_cents: tipCents, order_cents: begun.amount_cents - tipCents } : {}) })]);
    const confirmed = await stripe(`payment_intents/${intent.providerPaymentId}/confirm`, { payment_method: paymentMethod });
    const status = await stripeProvider().getPaymentStatus(intent.providerPaymentId!);
    if (status.status !== "pending") {
      const { api } = await db.service();
      const settled = await api.rpc("wayne_settle_payment", { payload: {
        payment_id: begun.payment_id, status: status.status, provider_payment_id: status.providerPaymentId, provider_status: status.providerStatus,
        amount_cents: status.status === "authorized" ? begun.amount_cents : status.amountCents, card_brand: status.cardBrand, card_last4: status.cardLast4,
        failure_reason: status.failureReason, metadata: { source: "pos_keyed_card", ...(status.status === "authorized" ? { tip_adjust: true, max_capture_cents: status.maxCapturableCents ?? begun.amount_cents } : {}) },
      } });
      expect(settled.error).toBeNull();
    }
    return { paymentId: begun.payment_id, amountCents: begun.amount_cents, intentId: intent.providerPaymentId!, idempotencyKey, confirmStatus: confirmed.status, status };
  }
  async function cashOut(orderId: string, extraTip: number) {
    await db.admin.query("insert into public.delivery_assignments(order_id, driver_id, status, picked_up_at) values($1,$2,'picked_up',now()) on conflict do nothing", [orderId, driverId]);
    const { api } = await db.service();
    const captured = await captureHeldCards({ service: api, workspaceId, locationId: null, requests: [{ order_id: orderId, tip_cents: extraTip }], keyPrefix: "driver-cashout" });
    expect(captured.problems).toEqual([]);
    const cashout = await asOwner<{ card_tips_cents: number }>("select public.wayne_pos_driver_cashout($1::uuid,$2::jsonb,$3::jsonb,'[]'::jsonb,'sandbox') value",
      [driverId, JSON.stringify([{ order_id: orderId, tip_cents: extraTip }]), JSON.stringify(captured.captures)]);
    return { captured, cashout };
  }
  const ledger = async (orderId: string) => (await db.admin.query(`select o.tip_cents, o.total_cents, p.amount_cents, p.status, p.metadata,
      (select a.tip_cents from public.delivery_assignments a where a.order_id=o.id) driver_tip
     from public.orders o join public.payments p on p.order_id=o.id where o.id=$1 and p.status in ('authorized','captured') limit 1`, [orderId])).rows[0];
  const customerIntents = async (customer: string) => (await stripe<{ data: Intent[] }>(`payment_intents?customer=${customer}&limit=20`)).json.data;
  const customerCharges = async (customer: string) => (await stripe<{ data: Charge[] }>(`charges?customer=${customer}&limit=20`)).json.data;
  const money = (charges: Charge[]) => charges.reduce((sum, charge) => sum + charge.amount_captured - charge.amount_refunded, 0);

  it("$30 + $5 phone tip: ONE $35 Stripe authorization, captured ONCE at cash-out, driver paid exactly $5, retry moves nothing", async () => {
    const orderId = await deliveryOrder();
    const card = await keyCard(orderId, 500, "pm_card_visa");
    expect(card.amountCents).toBe(3500);
    const held = (await stripe<Intent>(`payment_intents/${card.intentId}`)).json;
    expect(held).toMatchObject({ status: "requires_capture", amount: 3500, amount_capturable: 3500 });
    expect(held.metadata).toMatchObject({ wayne_tip_cents: "500", wayne_order_cents: "3000", wayne_payment_id: card.paymentId });
    const customer = held.customer!;
    expect(await customerIntents(customer)).toHaveLength(1);

    const { captured, cashout } = await cashOut(orderId, 0);
    expect(captured.captures[0]).toMatchObject({ captured_cents: 3500, tip_cents: 0 });
    const done = (await stripe<Intent>(`payment_intents/${card.intentId}`)).json;
    expect(done).toMatchObject({ status: "succeeded", amount_received: 3500 });
    const charges = await customerCharges(customer);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ amount: 3500, amount_captured: 3500, captured: true, payment_intent: card.intentId });
    expect(await ledger(orderId)).toMatchObject({ tip_cents: 500, total_cents: 3500, amount_cents: 3500, status: "captured", driver_tip: 500 });
    expect(cashout.card_tips_cents).toBe(500);

    // The cash-out pressed again: no new Stripe object, no new money.
    const { api } = await db.service();
    await captureHeldCards({ service: api, workspaceId, locationId: null, requests: [{ order_id: orderId, tip_cents: 0 }], keyPrefix: "driver-cashout" });
    expect(await customerIntents(customer)).toHaveLength(1);
    expect(money(await customerCharges(customer))).toBe(3500);
    expect((await ledger(orderId)).tip_cents).toBe(500);
  }, 120_000);

  it("$5 phone tip + $3 extra on the slip: $35 captured + $3 separate tip (never $5 again), driver $8; full refund returns exactly $35 + $3", async () => {
    const orderId = await deliveryOrder();
    const card = await keyCard(orderId, 500, "pm_card_visa");
    const customer = (await stripe<Intent>(`payment_intents/${card.intentId}`)).json.customer!;
    const { cashout } = await cashOut(orderId, 300);
    const intents = await customerIntents(customer);
    expect(intents.filter((intent) => intent.status === "succeeded").map((intent) => intent.amount_received).sort()).toEqual([300, 3500]);
    expect(intents.find((intent) => intent.amount_received === 300)?.metadata.wayne_tip_only).toBe("true");
    expect(money(await customerCharges(customer))).toBe(3800);
    expect(await ledger(orderId)).toMatchObject({ tip_cents: 800, total_cents: 3800, amount_cents: 3800, driver_tip: 800 });
    expect(cashout.card_tips_cents).toBe(800);

    // Full refund, tip selected explicitly (Admin → Orders → Refund).
    const begun = await asOwner<{ legs: RefundLeg[] }>("select public.wayne_begin_allocated_refund($1::jsonb) value",
      [JSON.stringify({ payment_id: card.paymentId, order_id: orderId, amount_cents: 3800, tip_cents: 800, reason: "Sandbox full refund", idempotency_key: `sandbox-refund-${randomUUID()}` })]);
    const legs = new Map(begun.legs.map((leg) => [leg.provider_payment_id, leg.amount_cents]));
    expect(legs.get(card.intentId)).toBe(3500);
    expect(legs.get(intents.find((intent) => intent.amount_received === 300)!.id)).toBe(300);
    const { api } = await db.service();
    expect(await reconcileRefundLegs(api, stripeProvider(), begun.legs)).toEqual({ pending: false });
    const after = await customerCharges(customer);
    expect(after.map((charge) => [charge.amount, charge.amount_refunded]).sort()).toEqual([[300, 300], [3500, 3500]]);
    expect(money(after)).toBe(0);
    const order = (await db.admin.query("select payment_status, tip_refunded_cents from public.orders where id=$1", [orderId])).rows[0];
    expect(order).toEqual({ payment_status: "refunded", tip_refunded_cents: 800 });
    // The driver was already paid $8: an $8 recovery due is recorded (never deducted automatically).
    expect((await db.admin.query("select coalesce(sum(amount_cents),0)::int n from public.driver_tip_recovery_dues where order_id=$1", [orderId])).rows[0].n).toBe(800);
  }, 120_000);

  it("a declined card, then a changed tip and a good card: one approval for the NEW total, nothing charged for the decline", async () => {
    const orderId = await deliveryOrder();
    const declined = await keyCard(orderId, 500, "pm_card_chargeDeclined");
    expect(declined.confirmStatus).toBe(402);
    expect(declined.status.status).toBe("failed");
    expect((await db.admin.query("select status from public.payments where id=$1", [declined.paymentId])).rows[0].status).toBe("failed");
    const good = await keyCard(orderId, 700, "pm_card_visa");
    expect(good.amountCents).toBe(3700);
    const customer = (await stripe<Intent>(`payment_intents/${good.intentId}`)).json.customer!;
    await cashOut(orderId, 0);
    const declinedIntent = (await stripe<Intent>(`payment_intents/${declined.intentId}`)).json;
    expect(declinedIntent.amount_received).toBe(0);
    expect(money(await customerCharges(customer))).toBe(3700);
    expect(await ledger(orderId)).toMatchObject({ tip_cents: 700, total_cents: 3700, amount_cents: 3700, driver_tip: 700 });
    expect((await db.admin.query("select count(*)::int n from public.payments where order_id=$1 and status='captured'", [orderId])).rows[0].n).toBe(1);
  }, 120_000);

  it("a lost answer: asking Stripe again with the ORIGINAL idempotency key returns the same PaymentIntent, never a second one", async () => {
    const orderId = await deliveryOrder();
    const card = await keyCard(orderId, 500, "pm_card_visa");
    const again = await stripeProvider().createOnlinePaymentIntent({
      amountCents: 3500, idempotencyKey: card.idempotencyKey, referenceId: (await db.admin.query("select order_number from public.orders where id=$1", [orderId])).rows[0].order_number,
      paymentId: card.paymentId, receiptEmail: null, note: (await stripe<{ description: string }>(`payment_intents/${card.intentId}`)).json.description, tipAdjust: true, tipCents: 500,
    });
    expect(again.providerPaymentId).toBe(card.intentId);
    const customer = (await stripe<Intent>(`payment_intents/${card.intentId}`)).json.customer!;
    expect(await customerIntents(customer)).toHaveLength(1);
    // A second approval on the same order is refused by the database while this one is open.
    await expect(asOwner("select public.wayne_begin_payment($1::jsonb) value", [JSON.stringify({ order_id: orderId, idempotency_key: `pos-keyed-card-${orderId}-${randomUUID()}`, entry: "pos_keyed_card", method: "card" })]))
      .rejects.toThrow(/already/);
    await cashOut(orderId, 0);
    expect(money(await customerCharges(customer))).toBe(3500);
  }, 120_000);
});
