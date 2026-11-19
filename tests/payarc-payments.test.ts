import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPayarcProvider, mapPayarcCharge } from "@/lib/payments/payarc";
import { payarcSecrets } from "@/lib/payments/capabilities";
import { payarcWebhookIdentity } from "@/lib/payments/payarc-webhook";
import { startTipPostgres, workspaceId, ownerId } from "./helpers/tip-postgres";
vi.mock("server-only", () => ({}));

describe("Payarc processor boundaries", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("requires explicit captured evidence and keeps unknown states pending", () => {
    expect(mapPayarcCharge({ id: "charge", status: "submitted_for_settlement", captured: 1, amount: "3500", amount_captured: 3500 }).status).toBe("captured");
    expect(mapPayarcCharge({ id: "charge", status: "submitted_for_settlement", captured: 0, amount: 3500 }).status).toBe("pending");
    expect(mapPayarcCharge({ id: "charge", status: "unexpected", captured: 1 }).status).toBe("pending");
    expect(mapPayarcCharge({ status: "authorized", amount: "35.50" }).amountCents).toBeNull();
  });
  it("does not mix sandbox credentials into a production connection", () => {
    expect(payarcSecrets("env:PAYARC", "production", { NODE_ENV: "test", PAYARC_ENVIRONMENT: "sandbox", PAYARC_API_TOKEN: "token" })).toBeNull();
  });
  it("sends a token, integer cents and a stable idempotency key to the selected merchant API", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: { id: "charge", captured: 1, status: "submitted_for_settlement", amount_captured: 3500 } }));
    vi.stubGlobal("fetch", fetcher);
    await createPayarcProvider({ apiToken: "private", environment: "sandbox" }).createOnlinePayment({ sourceId: "token", amountCents: 3500, idempotencyKey: "stable-key", referenceId: "WAYNES reference", note: "Order" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://testapi.payarc.net/v1/charges");
    expect(init.headers).toMatchObject({ Authorization: "Bearer private", "Idempotency-Key": "stable-key" });
    expect(JSON.parse(init.body)).toEqual({ token_id: "token", amount: 3500, capture: 1, currency: "usd", statement_description: "WAYNES reference" });
  });
  it("treats timeouts and malformed responses as uncertain and never echoes processor bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret")));
    const provider = createPayarcProvider({ apiToken: "private", environment: "production" });
    await expect(provider.getPaymentStatus("charge")).rejects.toMatchObject({ retryable: true, code: "NETWORK" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret", { status: 500 })));
    await expect(provider.getPaymentStatus("charge")).rejects.toMatchObject({ retryable: true, code: "PAYARC_HTTP_500" });
  });
  it("extracts only charge identity from callbacks and never claims an unsigned signature verified", () => {
    const raw = JSON.stringify({ request_payload: { card_number: "sensitive", cvv: "sensitive" }, api_response: { original: { data: { object: "Charge", id: "charge", captured: 1 } } } });
    expect(payarcWebhookIdentity(raw)).toEqual({ chargeId: "charge", refund: false });
    expect(createPayarcProvider({ apiToken: "private", environment: "sandbox" }).handleWebhook({ rawBody: raw, signature: null })).toEqual({ signatureVerified: false, eventId: "", eventType: "", payload: {} });
  });
});

describe("Payarc durable ledger (isolated PostgreSQL)", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  let connectionId: string;
  beforeAll(async () => {
    db = await startTipPostgres();
    const location = (await db.admin.query("select id from public.locations where workspace_id=$1 limit 1", [workspaceId])).rows[0].id;
    await db.admin.query("update public.location_payment_configurations set provider='payarc',environment='sandbox',online_card_enabled=true,terminal_card_enabled=false where location_id=$1", [location]);
    const connection = (await db.admin.query("select id from public.payment_connections where workspace_id=$1 and provider='payarc' and status<>'disabled'", [workspaceId])).rows[0];
    connectionId = connection.id;
    await db.admin.query("update public.payment_connections set status='connected',verified_at=now() where id=$1", [connectionId]);
  }, 120_000);
  afterAll(async () => { await db?.stop(); });
  afterEach(async () => { await db?.closeTestClients(); });
  async function fixture() {
    const fixture = await db.fixture();
    await db.admin.query("delete from public.payments where id=$1", [fixture.paymentId]);
    await db.admin.query("update public.orders set is_test=false,payment_status='unpaid' where id=$1", [fixture.orderId]);
    const { api } = await db.service();
    const args = { target_connection_id: connectionId, target_order_id: fixture.orderId, request_key: randomUUID(), expected_cents: fixture.amount };
    const result = await api.rpc("wayne_begin_payarc_payment", args);
    expect(result.error).toBeNull();
    return { ...fixture, api, args, attempt: result.data as { payment_id: string; reference: string } };
  }
  it("creates one attempt, replays it, and refuses a changed amount or concurrent tender", async () => {
    const f = await fixture();
    expect((await f.api.rpc("wayne_begin_payarc_payment", f.args)).data).toMatchObject({ payment_id: f.attempt.payment_id, duplicate: true });
    expect((await f.api.rpc("wayne_begin_payarc_payment", { ...f.args, expected_cents: f.amount + 1 })).error).not.toBeNull();
    expect((await f.api.rpc("wayne_begin_payarc_payment", { ...f.args, request_key: randomUUID() })).error).not.toBeNull();
  });
  it("recovers a lost charge response by the unique statement reference, verifies amount and fences stale callbacks", async () => {
    const f = await fixture();
    const payload = { provider_payment_id: `charge_${randomUUID()}`, reference: f.attempt.reference, status: "captured", provider_status: "submitted_for_settlement", amount_cents: f.amount };
    expect((await f.api.rpc("wayne_settle_payarc_payment", { target_connection_id: connectionId, payload: { ...payload, amount_cents: f.amount + 1 } })).error).not.toBeNull();
    expect((await f.api.rpc("wayne_settle_payarc_payment", { target_connection_id: connectionId, payload })).error).toBeNull();
    expect((await f.api.rpc("wayne_settle_payarc_payment", { target_connection_id: connectionId, payload: { ...payload, status: "failed" } })).error).toBeNull();
    expect((await db.admin.query("select status,provider_payment_id from public.payments where id=$1", [f.attempt.payment_id])).rows[0]).toEqual({ status: "captured", provider_payment_id: payload.provider_payment_id });
    expect((await db.admin.query("select payment_status from public.orders where id=$1", [f.orderId])).rows[0].payment_status).toBe("paid");
  });
  it("rejects charge rebinding and unbound or cross-connection callback identities", async () => {
    const f = await fixture();
    const payload = { provider_payment_id: `charge_${randomUUID()}`, reference: f.attempt.reference, status: "pending", amount_cents: f.amount };
    expect((await f.api.rpc("wayne_settle_payarc_payment", { target_connection_id: connectionId, payload })).error).toBeNull();
    expect((await f.api.rpc("wayne_settle_payarc_payment", { target_connection_id: connectionId, payload: { ...payload, provider_payment_id: "different_charge" } })).error).not.toBeNull();
    expect((await f.api.rpc("wayne_settle_payarc_payment", { target_connection_id: randomUUID(), payload })).error).not.toBeNull();
  });
  async function staffRpc(name: string, args: unknown[]) {
    await db.admin.query("begin; set local role authenticated");
    await db.admin.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
    try {
      const result = await db.admin.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) value`, args);
      await db.admin.query("commit");
      return result.rows[0].value;
    } catch (error) { await db.admin.query("rollback"); throw error; }
  }
  it("allocates Payarc refunds and reserves exactly one processor submission", async () => {
    const f = await fixture();
    const chargeId = `charge_${randomUUID()}`;
    await f.api.rpc("wayne_settle_payarc_payment", { target_connection_id: connectionId, payload: { provider_payment_id: chargeId, reference: f.attempt.reference, status: "captured", provider_status: "settled", amount_cents: f.amount } });
    const payload = { payment_id: f.attempt.payment_id, order_id: f.orderId, amount_cents: 100, tip_cents: 0, reason: "Wrong item", idempotency_key: randomUUID() };
    const refund = await staffRpc("wayne_begin_allocated_refund", [payload]);
    expect(refund.legs).toHaveLength(1);
    expect((await f.api.rpc("wayne_claim_payarc_refund", { target_refund_id: refund.legs[0].id })).data).toBe(true);
    expect((await f.api.rpc("wayne_claim_payarc_refund", { target_refund_id: refund.legs[0].id })).data).toBe(false);
    expect((await staffRpc("wayne_begin_allocated_refund", [payload])).legs[0].id).toBe(refund.legs[0].id);
    await expect(staffRpc("wayne_prepare_payment_void", [f.attempt.payment_id, f.orderId])).rejects.toThrow("existing refunds");
  });
  it("voids an unbatched capture and restores the order balance without fabricating a refund", async () => {
    const f = await fixture();
    const chargeId = `charge_${randomUUID()}`;
    await f.api.rpc("wayne_settle_payarc_payment", { target_connection_id: connectionId, payload: { provider_payment_id: chargeId, reference: f.attempt.reference, status: "captured", provider_status: "submitted_for_settlement", amount_cents: f.amount } });
    expect(await staffRpc("wayne_prepare_payment_void", [f.attempt.payment_id, f.orderId])).toMatchObject({ provider: "payarc", provider_payment_id: chargeId });
    const finish = await f.api.rpc("wayne_finish_payment_void", { target_payment_id: f.attempt.payment_id, provider_id: chargeId });
    expect(finish.error).toBeNull();
    expect((await db.admin.query("select status from public.payments where id=$1", [f.attempt.payment_id])).rows[0].status).toBe("voided");
    expect((await db.admin.query("select payment_status from public.orders where id=$1", [f.orderId])).rows[0].payment_status).toBe("unpaid");
    expect((await db.admin.query("select count(*)::int n from public.refunds where payment_id=$1", [f.attempt.payment_id])).rows[0].n).toBe(0);
  });
  it("denies authenticated browsers the server-only Payarc settlement functions", async () => {
    await expect(staffRpc("wayne_settle_payarc_payment", [connectionId, {}])).rejects.toThrow("permission denied");
  });
});
