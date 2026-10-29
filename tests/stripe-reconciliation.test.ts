import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyStripeWebhookEvent } from "@/lib/payments/stripe-webhook";
import type { ProviderPayment } from "@/lib/payments/provider";
import { startTipPostgres, workspaceId } from "./helpers/tip-postgres";
vi.mock("server-only", () => ({}));

describe("Stripe ordering and retained replacement reconciliation (real PostgreSQL)", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  beforeAll(async () => { db = await startTipPostgres(); }, 120_000);
  afterEach(async () => { await db.closeTestClients(); });
  afterAll(async () => { await db?.stop(); });
  const provider = (id: string, status: ProviderPayment["status"], amount: number): ProviderPayment => ({ providerPaymentId: id, status, providerStatus: { pending: "processing", authorized: "requires_capture", captured: "succeeded", failed: "requires_payment_method", voided: "canceled" }[status], amountCents: amount, cardBrand: "visa", cardLast4: "4242", receiptUrl: null, failureReason: null });
  async function deliver(id: string, latest: ProviderPayment, eventType = "payment_intent.created", snapshotStatus = "requires_payment_method", scope = workspaceId, metadata = {}) {
    const { api } = await db.service();
    return applyStripeWebhookEvent(api, eventType, { data: { object: { id, status: snapshotStatus, amount: 1, metadata } } }, scope, async () => latest);
  }
  async function ledger(id: string) { return (await db.admin.query("select p.*,o.tip_cents,o.total_cents,o.payment_status from public.payments p join public.orders o on o.id=p.order_id where p.id=$1", [id])).rows[0]; }
  async function rpc(payload: Record<string, unknown>, scope = workspaceId) {
    const { api } = await db.service();
    return api.rpc("wayne_settle_stripe_payment", { target_workspace_id: scope, payload });
  }
  async function replacement() {
    const f = await db.fixture(); const { api } = await db.service(); const token = randomUUID();
    const claim = await api.rpc("wayne_claim_tip_operation", { target_payment_id: f.paymentId, target_workspace_id: workspaceId, requested_tip: 500, worker_token: token, origin: "regression" });
    const op = (claim.data as { operation: { id: string } }).operation;
    const id = `pi_replacement_${randomUUID().replaceAll("-", "")}`;
    await api.rpc("wayne_update_tip_operation", { target_operation_id: op.id, worker_token: token, action: "plan", details: { mode: "replacement", amount_cents: f.amount + 500, fallback_amount_cents: f.amount } });
    await api.rpc("wayne_update_tip_operation", { target_operation_id: op.id, worker_token: token, action: "bind", details: { provider_id: id } });
    return { ...f, replacementId: id, operationId: op.id };
  }
  it("reproduces staging: delayed created must not fail an authorized payment", async () => {
    const f = await db.fixture(); await deliver(f.originalId, provider(f.originalId, "authorized", f.amount));
    expect((await ledger(f.paymentId)).status).toBe("authorized");
  });
  it("uses the authoritative captured amount when an older success snapshot has a different amount", async () => {
    const f = await db.fixture(); await db.admin.query("update public.payments set metadata='{}' where id=$1", [f.paymentId]); await deliver(f.originalId, provider(f.originalId, "captured", f.amount), "payment_intent.succeeded", "succeeded");
    expect(await ledger(f.paymentId)).toMatchObject({ amount_cents: f.amount, status: "captured" });
  });
  it("repairs the exact retained failed $20 ledger from the persisted $25 replacement, while capture is disabled", async () => {
    const f = await replacement();
    await db.admin.query("update public.payments set status='failed',failed_at=now(),failure_reason='stale created event' where id=$1", [f.paymentId]);
    await db.admin.query("update public.pos_tip_capture_control set execution_enabled=false");
    try {
      const latest = provider(f.replacementId, "captured", f.amount + 500);
      await deliver(f.replacementId, latest, "payment_intent.succeeded", "succeeded", workspaceId, { wayne_tip_operation: f.operationId });
      await deliver(f.replacementId, latest, "payment_intent.created");
      expect(await ledger(f.paymentId)).toMatchObject({ status: "captured", amount_cents: f.amount + 500, tip_cents: 500, total_cents: f.amount + 500, provider_payment_id: f.replacementId, payment_status: "paid", failure_reason: "stale created event" });
      expect((await db.admin.query("select state,release_pending from public.pos_tip_operations where id=$1", [f.operationId])).rows[0]).toEqual({ state: "succeeded", release_pending: true });
      expect((await db.admin.query("select count(*)::int n from public.order_events where order_id=$1 and event_type='payment.tip_captured'", [f.orderId])).rows[0].n).toBe(1);
    } finally { await db.admin.query("update public.pos_tip_capture_control set execution_enabled=true"); }
  });
  it("does not let a canceled or failed snapshot roll a captured payment back", async () => {
    const f = await db.fixture(); await db.admin.query("update public.payments set status='captured' where id=$1", [f.paymentId]);
    await deliver(f.originalId, provider(f.originalId, "captured", f.amount), "payment_intent.canceled", "canceled");
    await deliver(f.originalId, provider(f.originalId, "captured", f.amount), "payment_intent.payment_failed");
    expect((await ledger(f.paymentId)).status).toBe("captured");
  });
  it("fences stale negative readbacks after a newer capture commits", async () => {
    const f = await db.fixture(); await db.admin.query("update public.payments set status='captured' where id=$1", [f.paymentId]);
    for (const status of ["failed", "authorized", "voided"]) {
      expect((await rpc({ provider_payment_id: f.originalId, status, amount_cents: f.amount })).error).toBeNull();
    }
    expect((await ledger(f.paymentId)).status).toBe("captured");
  });
  it("does not turn an authorization into failure from an earlier requires-payment-method read", async () => {
    const f = await db.fixture(); await rpc({ provider_payment_id: f.originalId, status: "failed", amount_cents: f.amount });
    expect((await ledger(f.paymentId)).status).toBe("authorized");
  });
  it("can recover a failed normal payment from authoritative success with history retained", async () => {
    const f = await db.fixture(); await db.admin.query("update public.payments set status='failed',metadata='{}',failed_at=now() where id=$1", [f.paymentId]);
    await deliver(f.originalId, provider(f.originalId, "captured", f.amount), "payment_intent.payment_failed");
    expect(await ledger(f.paymentId)).toMatchObject({ status: "captured", payment_status: "paid" });
    expect((await ledger(f.paymentId)).failed_at).not.toBeNull();
  });
  it("does not settle a different workspace or provider through a colliding reference", async () => {
    const f = await db.fixture(); await deliver(f.originalId, provider(f.originalId, "captured", f.amount), "payment_intent.succeeded", "succeeded", randomUUID());
    expect((await ledger(f.paymentId)).status).toBe("authorized");
    await db.admin.query("update public.payments set provider='square' where id=$1", [f.paymentId]);
    await deliver(f.originalId, provider(f.originalId, "captured", f.amount));
    expect((await ledger(f.paymentId)).status).toBe("authorized");
  });
  it("rejects an authoritative lookup returning another intent", async () => {
    const f = await db.fixture(); await expect(deliver(f.originalId, provider("pi_wrong", "captured", f.amount))).rejects.toThrow();
    expect((await ledger(f.paymentId)).status).toBe("authorized");
  });
  it("retries rather than applying the snapshot when Stripe lookup fails", async () => {
    const f = await db.fixture(); const { api } = await db.service();
    await expect(applyStripeWebhookEvent(api, "payment_intent.created", { data: { object: { id: f.originalId, status: "requires_payment_method" } } }, workspaceId, async () => { throw Error("network unavailable"); })).rejects.toThrow("network unavailable");
    expect((await ledger(f.paymentId)).status).toBe("authorized");
  });
  it("refuses a replacement receipt with a wrong amount or changed ledger identity", async () => {
    const f = await replacement();
    await expect(deliver(f.replacementId, provider(f.replacementId, "captured", f.amount + 600), "payment_intent.succeeded", "succeeded", workspaceId, { wayne_tip_operation: f.operationId })).rejects.toThrow();
    await db.admin.query("update public.payments set provider_payment_id='pi_unrelated',status='failed' where id=$1", [f.paymentId]);
    await expect(deliver(f.replacementId, provider(f.replacementId, "captured", f.amount + 500), "payment_intent.succeeded", "succeeded", workspaceId, { wayne_tip_operation: f.operationId })).rejects.toThrow();
    expect((await ledger(f.paymentId)).tip_cents).toBe(0);
  });
  it("reconciles success exactly once while delayed negative readbacks compete", async () => {
    const f = await replacement();
    await db.admin.query("update public.payments set status='failed' where id=$1", [f.paymentId]);
    await Promise.all(Array.from({ length: 6 }, (_, i) => deliver(i % 2 ? f.originalId : f.replacementId,
      provider(i % 2 ? f.originalId : f.replacementId, i % 2 ? "failed" : "captured", i % 2 ? f.amount : f.amount + 500))));
    expect(await ledger(f.paymentId)).toMatchObject({ status: "captured", amount_cents: f.amount + 500, tip_cents: 500 });
    expect((await db.admin.query("select count(*)::int n from public.order_events where order_id=$1 and event_type='payment.reconciled'", [f.orderId])).rows[0].n).toBe(1);
  });
  it("does not revive an explicitly voided ledger through tip recovery", async () => {
    const f = await replacement(); await db.admin.query("update public.payments set status='voided' where id=$1", [f.paymentId]);
    await expect(deliver(f.replacementId, provider(f.replacementId, "captured", f.amount + 500))).rejects.toThrow();
    expect((await ledger(f.paymentId)).status).toBe("voided");
  });
  it("does not hide an original authorization already captured before its replacement", async () => {
    const f = await replacement(); await db.admin.query("update public.payments set status='captured' where id=$1", [f.paymentId]);
    await expect(deliver(f.replacementId, provider(f.replacementId, "captured", f.amount + 500))).rejects.toThrow("Original authorization may also have been captured");
    expect((await ledger(f.paymentId)).provider_payment_id).toBe(f.originalId);
  });
  it("denies webhook settlement RPCs to authenticated callers", async () => {
    const client = await db.connect(); await client.query("set role authenticated");
    await expect(client.query("select public.wayne_settle_stripe_payment($1,$2)", [workspaceId, JSON.stringify({ provider_payment_id: "pi_unknown", status: "captured", amount_cents: 2000 })])).rejects.toMatchObject({ code: "42501" });
  });
  it("keeps unknown/in-progress provider outcomes out of the ledger", async () => {
    const f = await db.fixture(); await deliver(f.originalId, provider(f.originalId, "pending", f.amount));
    expect((await ledger(f.paymentId)).status).toBe("authorized");
  });

  it("does not pass a provider-reference OR selector to the legacy settlement RPC", async () => {
    const f = await db.fixture(); const other = await db.fixture();
    await db.admin.query("update public.payments set metadata='{}' where id=$1", [f.paymentId]);
    await db.admin.query("update public.payments set provider='square',provider_payment_id=$1,created_at=now()+interval '1 second' where id=$2", [f.originalId, other.paymentId]);
    await deliver(f.originalId, provider(f.originalId, "captured", f.amount));
    expect((await ledger(f.paymentId)).status).toBe("captured");
    expect((await ledger(other.paymentId)).status).toBe("authorized");
  });

  it("does not fail a new intent that is merely waiting for its first payment method", async () => {
    const f = await db.fixture(); await db.admin.query("update public.payments set status='pending' where id=$1", [f.paymentId]);
    await deliver(f.originalId, provider(f.originalId, "failed", f.amount));
    expect((await ledger(f.paymentId)).status).toBe("pending");
  });
  it("records a real current decline while a payment is pending", async () => {
    const f = await db.fixture(); await db.admin.query("update public.payments set status='pending' where id=$1", [f.paymentId]);
    await deliver(f.originalId, { ...provider(f.originalId, "failed", f.amount), failureReason: "Current card declined" }, "payment_intent.payment_failed");
    expect((await ledger(f.paymentId)).status).toBe("failed");
  });
  it("preserves the legacy replaced-hold cancellation guard using current metadata", async () => {
    const f = await db.fixture();
    await deliver(f.originalId, { ...provider(f.originalId, "voided", f.amount), metadata: { wayne_replaced_by: "pi_saved_replacement" } }, "payment_intent.created");
    expect((await ledger(f.paymentId)).status).toBe("authorized");
  });

});
