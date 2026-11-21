import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPayarcProvider } from "@/lib/payments/payarc";
import { executePayarcPayment, type PayarcAttempt } from "@/lib/payments/payarc-operation";
import { runPayarcTipOperation } from "@/lib/payments/payarc-tip-operation";
import type { PaymentProvider, ProviderPayment } from "@/lib/payments/provider";
import { ownerId, startTipPostgres, workspaceId } from "./helpers/tip-postgres";
vi.mock("server-only", () => ({}));

describe("original Payarc card adapter", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reads the original card and charges only the extra, without reusing the checkout token", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ data: {
      id: "original", captured: 1, status: "settled", amount: 3000, card: { data: { id: "saved_card", customer_id: "customer" } },
    } })).mockResolvedValueOnce(Response.json({ data: { id: "extra", captured: 1, status: "submitted_for_settlement", amount: 535, statement_description: "WAYNES extra" } }));
    vi.stubGlobal("fetch", fetcher);
    const result = await createPayarcProvider({ apiToken: "private", environment: "sandbox" }).createAdditionalPayment!({
      originalProviderPaymentId: "original", amountCents: 535, idempotencyKey: "saved-extra-request", referenceId: "WAYNES extra",
    });
    expect(fetcher.mock.calls[0][0]).toBe("https://testapi.payarc.net/v1/charges/original");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ card_id: "saved_card", customer_id: "customer", amount: 535, currency: "usd", capture: 1, statement_description: "WAYNES extra" });
    expect(result).toMatchObject({ providerPaymentId: "extra", amountCents: 535, status: "captured" });
  });
  it("never submits a charge if the original card identity is missing or mismatched", async () => {
    for (const data of [{ id: "other", captured: 1, status: "settled", card: { data: { id: "card" } } }, { id: "original", captured: 1, status: "settled" }]) {
      const fetcher = vi.fn().mockResolvedValue(Response.json({ data }));
      vi.stubGlobal("fetch", fetcher);
      await expect(createPayarcProvider({ apiToken: "private", environment: "sandbox" }).createAdditionalPayment!({ originalProviderPaymentId: "original", amountCents: 535, idempotencyKey: "saved-key", referenceId: "ref" })).rejects.toMatchObject({ code: "ORIGINAL_CARD_UNAVAILABLE", retryable: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});

describe("online extras on the original card (isolated real PostgreSQL)", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  let connectionId: string;
  beforeAll(async () => {
    db = await startTipPostgres();
    await db.admin.query("update public.location_payment_configurations set provider='payarc',environment='sandbox',online_card_enabled=true,terminal_card_enabled=false where workspace_id=$1", [workspaceId]);
    connectionId = (await db.admin.query("select id from public.payment_connections where provider='payarc' and status<>'disabled' and workspace_id=$1", [workspaceId])).rows[0].id;
    await db.admin.query("update public.payment_connections set status='connected',verified_at=now() where id=$1", [connectionId]);
  }, 120_000);
  afterAll(async () => { await db?.stop(); });
  afterEach(async () => { await db?.closeTestClients(); });
  async function fixture() {
    const f = await db.fixture();
    await db.admin.query("delete from public.payments where id=$1", [f.paymentId]);
    await db.admin.query("update public.orders set source='online',is_test=false,fulfillment_type='delivery',status='out_for_delivery',payment_status='unpaid',total_cents=total_cents+535 where id=$1", [f.orderId]);
    await db.admin.query("insert into public.payments(id,order_id,provider,provider_payment_id,method,amount_cents,status,captured_at,metadata) values($1,$2,'payarc',$3,'card',$4,'captured',now(),$5)", [f.paymentId, f.orderId, f.originalId, f.amount, { entry: "online", payarc_connection_id: connectionId }]);
    const { api } = await db.service();
    const args = { target_order_id: f.orderId, target_workspace_id: workspaceId, target_location_id: null, target_connection_id: connectionId, request_key: `online-extra-${randomUUID()}`, expected_cents: 535, actor_id: ownerId };
    return { ...f, api, args };
  }
  const reserve = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const answer = await f.api.rpc("wayne_begin_online_extra_payment", f.args);
    expect(answer.error).toBeNull();
    return answer.data as PayarcAttempt & { original_provider_payment_id: string };
  };
  async function queue() {
    await db.admin.query("begin;set local role authenticated");
    await db.admin.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
    const result = (await db.admin.query("select public.wayne_pos_tip_queue() value")).rows[0].value as Array<{ payment_id: string }>;
    await db.admin.query("commit"); return result;
  }
  it("charges the computed added balance once, preserves the original, and still allows a slip tip", async () => {
    const f = await fixture();
    const attempt = await reserve(f);
    expect(attempt.amount_cents).toBe(535);
    expect(attempt.original_provider_payment_id).toBe(f.originalId);
    const reference = attempt.reference;
    const extra: ProviderPayment = { providerPaymentId: `extra_${randomUUID()}`, amountCents: 535, status: "captured", providerStatus: "submitted_for_settlement", cardBrand: "visa", cardLast4: "4242", receiptUrl: null, failureReason: null, metadata: { wayne_payarc_reference: reference } };
    let original: ProviderPayment = { ...extra, providerPaymentId: f.originalId, amountCents: f.amount, tipAmountCents: 0 };
    const create = vi.fn(async () => extra);
    const provider = { code: "payarc", createAdditionalPayment: create, getPaymentStatus: async (id: string) => id === f.originalId ? original : extra,
      adjustTip: async (_id: string, input: { tipCents: number }) => (original = { ...original, tipAmountCents: input.tipCents, amountCents: f.amount + input.tipCents }),
    } as unknown as PaymentProvider;
    const run = (p: typeof attempt) => executePayarcPayment(f.api, provider, connectionId, p, "", f.args.request_key, p.original_provider_payment_id);
    expect((await run(attempt)).status).toBe("captured");
    expect((await run(await reserve(f))).status).toBe("captured");
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ originalProviderPaymentId: f.originalId, amountCents: 535, idempotencyKey: f.args.request_key, referenceId: reference });
    expect((await db.admin.query("select amount_cents from public.payments where id=$1", [f.paymentId])).rows[0].amount_cents).toBe(f.amount);
    const pendingTips = await queue();
    expect(pendingTips.some((row) => row.payment_id === f.paymentId)).toBe(true);
    expect(pendingTips.some((row) => row.payment_id === attempt.payment_id)).toBe(false);
    const delivery = (await db.admin.query("select public.wayne_pos_delivery_order_json($1) value", [f.orderId])).rows[0].value;
    expect(delivery.paid_by).toBe("card_adjustable");
    await runPayarcTipOperation({ service: f.api, workspaceId, paymentId: f.paymentId, providerPaymentId: f.originalId, extraCents: 300, provider });
    const order = (await db.admin.query("select total_cents,tip_cents,payment_status from public.orders where id=$1", [f.orderId])).rows[0];
    expect(order).toMatchObject({ total_cents: f.amount + 535 + 300, tip_cents: 300, payment_status: "paid" });
  });
  it("rejects stale amounts, another workspace, a non-online order, and an already-paid balance", async () => {
    const f = await fixture();
    for (const patch of [{ expected_cents: 536 }, { target_workspace_id: randomUUID() }, { target_location_id: randomUUID() }]) {
      expect((await f.api.rpc("wayne_begin_online_extra_payment", { ...f.args, ...patch })).error).not.toBeNull();
    }
    await db.admin.query("update public.orders set source='phone' where id=$1", [f.orderId]);
    expect((await f.api.rpc("wayne_begin_online_extra_payment", f.args)).error).not.toBeNull();
    await db.admin.query("update public.orders set source='online',total_cents=$2 where id=$1", [f.orderId, f.amount]);
    expect((await f.api.rpc("wayne_begin_online_extra_payment", f.args)).error).not.toBeNull();
  });
  it("a lost response cannot submit the same card again, even from another register", async () => {
    const f = await fixture();
    const attempts = await Promise.all([reserve(f), reserve(f)]);
    expect(attempts.filter((attempt) => !attempt.duplicate)).toHaveLength(1);
    expect(attempts[0].payment_id).toBe(attempts[1].payment_id);
    const provider = { code: "payarc", createAdditionalPayment: vi.fn(async () => { throw new Error("Lost charge response"); }) } as unknown as PaymentProvider;
    const first = attempts.find((attempt) => !attempt.duplicate)!;
    await expect(executePayarcPayment(f.api, provider, connectionId, first, "", f.args.request_key, first.original_provider_payment_id)).rejects.toThrow("Lost charge response");
    const retry = await reserve(f);
    expect((await executePayarcPayment(f.api, provider, connectionId, retry, "", f.args.request_key, retry.original_provider_payment_id)).status).toBe("pending");
    expect(provider.createAdditionalPayment).toHaveBeenCalledTimes(1);
    expect((await f.api.rpc("wayne_begin_online_extra_payment", { ...f.args, request_key: `online-extra-${randomUUID()}` })).error).not.toBeNull();
  });
});
