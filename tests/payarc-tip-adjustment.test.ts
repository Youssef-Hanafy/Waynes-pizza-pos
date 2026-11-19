import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startTipPostgres, ownerId, workspaceId } from "./helpers/tip-postgres";
import { runPayarcTipOperation } from "@/lib/payments/payarc-tip-operation";
import { createPayarcProvider } from "@/lib/payments/payarc";
import { cashoutSummary, type PosDeliveryOrder } from "@/lib/delivery/pos-board";
import type { PaymentProvider, ProviderPayment } from "@/lib/payments/provider";
vi.mock("server-only", () => ({}));

describe("Payarc tip endpoint", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("updates the existing charge, sends integer cents, and re-reads rather than trusting 200", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ success: true })).mockResolvedValueOnce(Response.json({ data: {
      id: "pc_original", amount: 3800, amount_captured: 3800, tip_amount: 300, captured: 1, status: "submitted_for_settlement",
    } }));
    vi.stubGlobal("fetch", fetcher);
    const result = await createPayarcProvider({ apiToken: "private", environment: "production" }).adjustTip!("pc_original", { tipCents: 300, idempotencyKey: "saved-operation" });
    expect(fetcher.mock.calls[0][0]).toBe("https://api.payarc.net/v1/charges/pc_original/tip_adjustment");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ tip: 300 });
    expect(fetcher.mock.calls[0][1].headers["Idempotency-Key"]).toBe("saved-operation");
    expect(fetcher.mock.calls[1][0]).toBe("https://api.payarc.net/v1/charges/pc_original");
    expect(result).toMatchObject({ providerPaymentId: "pc_original", amountCents: 3800, tipAmountCents: 300 });
  });
});

describe("Payarc adjustment and driver payout (real isolated PostgreSQL)", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  let connectionId: string;
  const driverId = randomUUID();
  beforeAll(async () => {
    db = await startTipPostgres();
    await db.admin.query("update public.location_payment_configurations set provider='payarc',environment='sandbox',online_card_enabled=true,terminal_card_enabled=false where workspace_id=$1", [workspaceId]);
    connectionId = (await db.admin.query("select id from public.payment_connections where provider='payarc' and status<>'disabled' and workspace_id=$1", [workspaceId])).rows[0].id;
    await db.admin.query("update public.payment_connections set status='connected',verified_at=now() where id=$1", [connectionId]);
    await db.admin.query("insert into auth.users(id,email) values($1,'payarc-driver@example.invalid')", [driverId]);
    await db.admin.query("update public.profiles set active=true,display_name='Payarc driver' where id=$1", [driverId]);
  }, 120_000);
  afterAll(async () => { await db?.stop(); });
  afterEach(async () => { await db?.closeTestClients(); });

  async function owner(sql: string, args: unknown[]) {
    await db.admin.query("begin;set local role authenticated");
    await db.admin.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
    try { const result = await db.admin.query(sql, args); await db.admin.query("commit"); return result.rows[0]?.value; }
    catch (error) { await db.admin.query("rollback"); throw error; }
  }
  async function fixture(extraCents = 300) {
    const f = await db.fixture();
    await db.admin.query("delete from public.payments where id=$1", [f.paymentId]);
    await db.admin.query("update public.orders set is_test=false,source='phone',fulfillment_type='delivery',status='out_for_delivery',payment_status='paid',tip_cents=500,total_cents=3500 where id=$1", [f.orderId]);
    const chargeId = `pc_${randomUUID()}`;
    await db.admin.query("insert into public.payments(id,order_id,provider,provider_payment_id,method,amount_cents,status,captured_at,metadata) values($1,$2,'payarc',$3,'card',3500,'captured',now(),$4)", [f.paymentId, f.orderId, chargeId, { payarc_connection_id: connectionId, payarc_reference: `WAYNES ${f.paymentId.replaceAll("-", "").slice(0, 18)}` }]);
    let current: ProviderPayment = { providerPaymentId: chargeId, status: "captured", providerStatus: "submitted_for_settlement", amountCents: 3500, tipAmountCents: 0, cardBrand: "V", cardLast4: "5439", receiptUrl: null, failureReason: null };
    const adjust = vi.fn(async (_id: string, input: { tipCents: number }) => {
      current = { ...current, amountCents: current.amountCents! + input.tipCents - current.tipAmountCents!, tipAmountCents: input.tipCents };
      return { ...current };
    });
    const provider = { code: "payarc", adjustTip: adjust, getPaymentStatus: vi.fn(async () => ({ ...current })) } as unknown as PaymentProvider;
    const { api, failNextRpc, loseNextRpcResponse } = await db.service();
    const run = (extra = extraCents) => runPayarcTipOperation({ service: api, workspaceId, paymentId: f.paymentId, providerPaymentId: chargeId, extraCents: extra, provider });
    const row = async () => (await db.admin.query("select o.total_cents,o.tip_cents,p.amount_cents,p.metadata from public.orders o join public.payments p on p.order_id=o.id where p.id=$1", [f.paymentId])).rows[0];
    return { ...f, chargeId, api, run, row, adjust, provider, setCurrent: (patch: Partial<ProviderPayment>) => { current = { ...current, ...patch }; }, failNextRpc, loseNextRpcResponse };
  }
  it("adds only the $3 slip extra to a $35 payment already including a $5 phone tip, once", async () => {
    const f = await fixture();
    expect(await f.run()).toMatchObject({ captured_cents: 3800, tip_cents: 300 });
    expect(await f.row()).toMatchObject({ total_cents: 3800, tip_cents: 800, amount_cents: 3800 });
    await f.run();
    expect(f.adjust).toHaveBeenCalledTimes(1);
    expect(await f.row()).toMatchObject({ total_cents: 3800, tip_cents: 800 });
    expect((await db.admin.query("select count(*)::int n from public.payments where order_id=$1", [f.orderId])).rows[0].n).toBe(1);
  });
  it("finalizes no extra tip without calling the adjustment API, even if already settled", async () => {
    const f = await fixture(0); f.setCurrent({ providerStatus: "settled" });
    await f.run();
    expect(f.adjust).not.toHaveBeenCalled();
    expect(await f.row()).toMatchObject({ total_cents: 3500, tip_cents: 500 });
  });
  it("does not submit an adjustment after the batch has settled", async () => {
    const f = await fixture(); f.setCurrent({ providerStatus: "settled" });
    await expect(f.run()).rejects.toThrow("no longer eligible");
    expect(f.adjust).not.toHaveBeenCalled();
  });
  it("recovers a lost database receipt without another adjustment", async () => {
    const f = await fixture(); f.failNextRpc("wayne_complete_payarc_tip");
    await expect(f.run()).rejects.toThrow("receipt needs recovery");
    expect(await f.row()).toMatchObject({ total_cents: 3500, tip_cents: 500 });
    await f.run();
    expect(f.adjust).toHaveBeenCalledTimes(1);
    expect(await f.row()).toMatchObject({ total_cents: 3800, tip_cents: 800 });
  });
  it("never repeats a submitted but unconfirmed adjustment, and freezes its extra amount", async () => {
    const f = await fixture(); f.adjust.mockImplementation(async () => { throw new Error("lost response"); });
    await expect(f.run()).rejects.toThrow("has not confirmed");
    await expect(f.run()).rejects.toThrow("has not confirmed");
    expect(f.adjust).toHaveBeenCalledTimes(1);
    await expect(f.run(400)).rejects.toThrow("saved tip request");
    expect(await f.row()).toMatchObject({ total_cents: 3500, tip_cents: 500 });
    f.setCurrent({ amountCents: 3800, tipAmountCents: 300 });
    await f.run();
    expect(f.adjust).toHaveBeenCalledTimes(1);
  });
  it("refuses a mismatched total or identity and never marks a driver tip paid", async () => {
    const f = await fixture();
    f.adjust.mockImplementation(async () => ({ providerPaymentId: f.chargeId, status: "captured", providerStatus: "submitted_for_settlement", amountCents: 3900, tipAmountCents: 300, cardBrand: "V", cardLast4: "5439", receiptUrl: null, failureReason: null }));
    await expect(f.run()).rejects.toThrow("has not confirmed");
    expect(await f.row()).toMatchObject({ total_cents: 3500, tip_cents: 500 });
    await expect(owner("select public.wayne_prepare_payment_void($1,$2) value", [f.paymentId, f.orderId])).rejects.toThrow("pending Payarc tip");
  });
  it("serializes concurrent cash-out/tips submissions into one processor adjustment", async () => {
    const f = await fixture();
    const { api } = await db.service();
    await Promise.allSettled([f.run(), runPayarcTipOperation({ service: api, workspaceId, paymentId: f.paymentId, providerPaymentId: f.chargeId, extraCents: 300, provider: f.provider })]);
    await f.run();
    expect(f.adjust).toHaveBeenCalledTimes(1);
    expect(await f.row()).toMatchObject({ total_cents: 3800, tip_cents: 800 });
  });
  it("an authoritative webhook readback recovers the pending adjustment before checking the new total", async () => {
    const f = await fixture(); f.failNextRpc("wayne_complete_payarc_tip");
    await expect(f.run()).rejects.toThrow("receipt needs recovery");
    const payload = { provider_payment_id: f.chargeId, status: "captured", provider_status: "submitted_for_settlement", amount_cents: 3800, tip_amount: 300 };
    const result = await f.api.rpc("wayne_settle_payarc_payment", { target_connection_id: connectionId, payload });
    expect(result.error).toBeNull();
    expect(await f.row()).toMatchObject({ total_cents: 3800, tip_cents: 800, amount_cents: 3800 });
    await f.api.rpc("wayne_settle_payarc_payment", { target_connection_id: connectionId, payload });
    expect(await f.row()).toMatchObject({ total_cents: 3800, tip_cents: 800 });
  });
  it("browser roles cannot forge tip completion or bypass pending-tip refund fences", async () => {
    const f = await fixture(); f.adjust.mockImplementation(async () => { throw new Error("lost response"); });
    await expect(f.run()).rejects.toThrow("has not confirmed");
    await expect(owner("select public.wayne_complete_payarc_tip($1,$2) value", [randomUUID(), "{}"])).rejects.toThrow("permission denied");
    await expect(owner("select public.wayne_begin_allocated_refund($1) value", [JSON.stringify({ payment_id: f.paymentId, order_id: f.orderId, amount_cents: 100, tip_cents: 0, reason: "Wrong item", idempotency_key: randomUUID() })])).rejects.toThrow("pending Payarc tip");
  });
  it("refuses another workspace and payments split across cards", async () => {
    const f = await fixture();
    const current = await f.provider.getPaymentStatus(f.chargeId);
    const claimed = await f.api.rpc("wayne_claim_payarc_tip", { target_payment_id: f.paymentId, target_workspace_id: randomUUID(), extra_tip: 300, observed: { ...current, provider_payment_id: f.chargeId, amount_cents: 3500, tip_amount: 0 } });
    expect(claimed.error).not.toBeNull();
    await db.admin.query("insert into public.payments(order_id,provider,provider_payment_id,method,amount_cents,status,captured_at) values($1,'cash',gen_random_uuid()::text,'cash',100,'captured',now())", [f.orderId]);
    await expect(f.run()).rejects.toThrow("Split or changed payments");
    expect(f.adjust).not.toHaveBeenCalled();
  });
  it("driver cash-out cannot bypass the adjustment, then pays the confirmed $8 exactly once", async () => {
    const f = await fixture();
    await db.admin.query("insert into public.delivery_assignments(order_id,driver_id,status,picked_up_at) values($1,$2,'picked_up',now())", [f.orderId, driverId]);
    const before = (await db.admin.query("select public.wayne_pos_delivery_order_json($1) value", [f.orderId])).rows[0].value as PosDeliveryOrder;
    expect(before.paid_by).toBe("card_adjustable");
    expect(cashoutSummary([before], { [f.orderId]: 300 }).cardTips).toBe(800);
    const cashout = () => owner("select public.wayne_pos_driver_cashout($1,$2,'[]'::jsonb,'[]'::jsonb,'') value", [driverId, JSON.stringify([{ order_id: f.orderId, tip_cents: 300 }])]);
    await expect(cashout()).rejects.toThrow("Confirm the Payarc tip");
    await f.run();
    const result = await cashout();
    expect(result.card_tips_cents).toBe(800);
    expect(result.detail[0]).toMatchObject({ tip_cents: 800, total_cents: 3800 });
    const assigned = (await db.admin.query("select tip_cents,cashout_id from public.delivery_assignments where order_id=$1", [f.orderId])).rows[0];
    expect(assigned.tip_cents).toBe(800); expect(assigned.cashout_id).not.toBeNull();
  });
});
