import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyPayarcConnectOutcome } from "@/lib/payments/payarc-connect-operation";
import { payarcConnectAttemptSchema } from "@/lib/payments/payarc-connect";
import { ownerId, startTipPostgres, workspaceId } from "./helpers/tip-postgres";

vi.mock("server-only", () => ({}));

describe("PAX A35 payment ledger", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  let locationId: string;
  const connectionId = randomUUID();
  const terminalId = randomUUID();
  const serial = "0123456789";

  beforeAll(async () => {
    db = await startTipPostgres();
    locationId = (await db.admin.query("select id from public.locations where workspace_id=$1 limit 1", [workspaceId])).rows[0].id;
    await db.admin.query("update public.payment_connections set status='disabled' where workspace_id=$1 and location_id=$2 and purpose='online'", [workspaceId, locationId]);
    await db.admin.query(`insert into public.payment_connections(id, workspace_id, location_id, purpose, provider, connection_mode, status, verified_at)
      values($1, $2, $3, 'online', 'payarc', 'api', 'connected', now())`, [connectionId, workspaceId, locationId]);
    await db.admin.query(`insert into public.payment_terminals(id, workspace_id, location_id, label, device_id, status)
      values($1, $2, $3, 'Front counter', $4, 'active')`, [terminalId, workspaceId, locationId, serial]);
  }, 180_000);

  afterAll(async () => { await db?.stop(); });

  it("locks the server tip and balance, reuses the pending attempt, and records an approval exactly once", async () => {
    const first = await db.fixture();
    const second = await db.fixture();
    await db.admin.query("delete from public.payments where id in ($1, $2)", [first.paymentId, second.paymentId]);
    await db.admin.query(`update public.orders set payment_status='unpaid', is_test=false,
      tip_cents=500, total_cents=total_cents+500 where id in ($1, $2)`, [first.orderId, second.orderId]);
    const service = await db.service();
    const begin = (orderId: string, amount: number, key = randomUUID()) => service.api.rpc("wayne_begin_payarc_connect_payment", {
      target_connection_id: connectionId, target_order_id: orderId, target_terminal_id: terminalId,
      target_location_id: locationId, terminal_serial: serial, request_key: key, expected_cents: amount,
      split_cents: null, actor_id: ownerId,
    });
    expect((await begin(first.orderId, first.amount)).error?.code).toBe("40001");
    const opened = await begin(first.orderId, first.amount + 500);
    expect(opened.error).toBeNull();
    expect(opened.data).toMatchObject({ duplicate: false, metadata: { payarc_connect_tip_cents: 500 } });
    const attempt = payarcConnectAttemptSchema.parse(opened.data);
    expect((await begin(first.orderId, first.amount + 500)).data).toMatchObject({ id: attempt.id, duplicate: true });
    expect((await begin(second.orderId, second.amount + 500)).error?.code).toBe("40001");

    const traceId = randomUUID();
    const chargeId = randomUUID();
    const approval = {
      traceId, transactionId: attempt.metadata.payarc_connect_ref, transType: "SALE", status: "SUCCESS", chargeId,
      amount: { total: attempt.amount_cents, approved: attempt.amount_cents, tip: 500, tax: attempt.metadata.payarc_connect_tax_cents, currency: "USD" },
    };
    expect(await applyPayarcConnectOutcome(service.api, attempt, { ...approval, status: "TIMEOUT" })).toBe("pending");
    expect(await applyPayarcConnectOutcome(service.api, attempt, approval)).toBe("captured");
    expect(await applyPayarcConnectOutcome(service.api, attempt, approval)).toBe("captured");
    expect(await applyPayarcConnectOutcome(service.api, attempt, {
      ...approval,
      status: "DECLINE",
      amount: { ...approval.amount, approved: 0 },
    })).toBe("captured");
    const saved = await db.admin.query(`select o.payment_status, p.provider_payment_id, p.terminal_checkout_id, p.amount_cents,
      (select count(*)::int from public.order_events where order_id=o.id and event_type='payment.captured') captured_events
      from public.orders o join public.payments p on p.order_id=o.id where p.id=$1`, [attempt.id]);
    expect(saved.rows[0]).toEqual({
      payment_status: "paid", provider_payment_id: chargeId, terminal_checkout_id: traceId,
      amount_cents: first.amount + 500, captured_events: 1,
    });
    const openedSecond = await begin(second.orderId, second.amount + 500);
    expect(openedSecond.error).toBeNull();
    const secondAttempt = payarcConnectAttemptSchema.parse(openedSecond.data);
    expect(await applyPayarcConnectOutcome(service.api, secondAttempt, {
      traceId: randomUUID(),
      transactionId: secondAttempt.metadata.payarc_connect_ref,
      transType: "SALE",
      status: "100002 ABORTED",
      chargeId: randomUUID(),
      amount: { total: 0, approved: 0, currency: "USD", tip: 0, tax: 0 },
    })).toBe("voided");
    const retry = await begin(second.orderId, second.amount + 500);
    expect(retry.error).toBeNull();
    expect(retry.data).toMatchObject({ status: "pending", duplicate: false });
  });
});
