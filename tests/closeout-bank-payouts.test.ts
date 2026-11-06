import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { startTipPostgres, workspaceId, ownerId } from "./helpers/tip-postgres";
vi.mock("server-only", () => ({}));

const location = "40000000-0000-4000-8000-000000000002";
describe("Closeout bank payout queue (real PostgreSQL)", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  beforeAll(async () => { db = await startTipPostgres(); }, 120_000);
  afterEach(async () => { await db.closeTestClients(); });
  afterAll(async () => { await db?.stop(); });
  async function enable() {
    const connection = (await db.admin.query("select id from public.payment_connections where workspace_id=$1 and provider='stripe' limit 1", [workspaceId])).rows[0];
    await db.admin.query(`insert into public.closeout_payout_control(workspace_id,location_id,connection_id,account_id,bank_id,environment,start_business_date,enabled)
      values($1,$2,$3,'acct_test','ba_test','production',(now() at time zone 'America/New_York')::date,true) on conflict(location_id) do update set enabled=true,start_business_date=(now() at time zone 'America/New_York')::date`, [workspaceId, location, connection.id]);
  }
  async function queue(day?: string) {
    await db.admin.query('begin; set local role authenticated');
    await db.admin.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
    try {
      const r = await db.admin.query("select public.wayne_queue_bank_payout($1,$2,coalesce($3::date,(now() at time zone 'America/New_York')::date)) value", [workspaceId, location, day ?? null]);
      await db.admin.query("commit"); return r.rows[0].value;
    } catch (e) { await db.admin.query("rollback"); throw e; }
  }
  async function sale() {
    const f = await db.fixture();
    await db.admin.query("update public.orders set is_test=false,placed_at=now() where id=$1", [f.orderId]);
    return f;
  }
  async function claim() { return db.admin.query("select public.wayne_claim_bank_payout($1) value", [randomUUID()]); }
  it("is disabled by default and does not backfill existing closeouts", async () => {
    await sale(); expect(await queue()).toEqual({ enabled: false, queued: false });
    expect((await db.admin.query("select count(*)::int n from public.closeout_bank_payouts")).rows[0].n).toBe(0);
  });
  it("queues real Stripe cards once, excluding test/cash/manual cards and old dates", async () => {
    await enable();
    const real = await sale();
    const cash = await sale(); await db.admin.query("update public.payments set provider='cash',method='cash',status='captured' where id=$1", [cash.paymentId]);
    const test = await db.fixture(); await db.admin.query("update public.orders set is_test=true where id=$1", [test.orderId]);
    const first = await queue(); expect(first.enabled).toBe(true); expect(first.added).toBe(2); // earlier real sale + this real sale
    expect((await queue()).added).toBe(0);
    expect((await db.admin.query("select count(*)::int n from public.closeout_payout_items where source_id=$1", [real.paymentId])).rows[0].n).toBe(1);
    expect((await queue("2020-01-01")).queued).toBe(false);
  });
  it("allows one worker, rejects stale writes, and freezes a plan before network submission", async () => {
    const token = randomUUID();
    const a = (await db.admin.query("select public.wayne_claim_bank_payout($1) value", [token])).rows[0].value;
    expect(a.items.length).toBeGreaterThan(0);
    expect((await claim()).rows[0].value).toBeNull();
    await expect(db.admin.query("select public.wayne_update_bank_payout($1,$2,'plan',$3)", [a.batch.id, randomUUID(), { gross: 1000, refunds: 0, fees: 30, net: 970 }])).rejects.toThrow("lease");
    await db.admin.query("select public.wayne_update_bank_payout($1,$2,'plan',$3)", [a.batch.id, token, { gross: 1000, refunds: 0, fees: 30, net: 970 }]);
    const saved = (await db.admin.query("select * from public.closeout_bank_payouts where id=$1", [a.batch.id])).rows[0];
    expect(saved.state).toBe("submitting"); expect(saved.submitted_at).toBeTruthy(); expect(Number(saved.net_cents)).toBe(970);
    await expect(db.admin.query("select public.wayne_update_bank_payout($1,$2,'plan',$3)", [a.batch.id, token, { gross: 2000, net: 1940 }])).rejects.toThrow("frozen");
    await db.admin.query("select public.wayne_update_bank_payout($1,$2,'finish',$3)", [a.batch.id, token, { state: "pending", payout_id: "po_once" }]);
  });
  it("repeat closeout after a submitted batch creates only a supplemental batch for new sales", async () => {
    const f = await sale(); const q = await queue(); expect(q.added).toBe(1);
    const p = await db.admin.query("select payout_id from public.closeout_payout_items where source_id=$1", [f.paymentId]);
    expect(p.rows[0].payout_id).not.toBe((await db.admin.query("select id from public.closeout_bank_payouts where stripe_payout_id='po_once'")).rows[0].id);
    expect((await queue()).added).toBe(0);
  });
  it("denies non-managers and direct authenticated table access", async () => {
    const c = await db.connect();
    await c.query("set role authenticated");
    await expect(c.query("select * from public.closeout_bank_payouts")).rejects.toThrow("permission denied");
    await expect(c.query("select public.wayne_claim_bank_payout($1)", [randomUUID()])).rejects.toThrow("permission denied");
    await expect(c.query("select public.wayne_queue_bank_payout($1,$2,current_date)", [workspaceId, location])).rejects.toThrow("manager");
  });
  it("carries a refund-only negative closeout into the next payout exactly once", async () => {
    await db.admin.query("update public.closeout_bank_payouts set lease_until=null,next_attempt_at=now()+interval '1 day'");
    const control = (await db.admin.query("select * from public.closeout_payout_control")).rows[0];
    const debt = randomUUID(); const next = randomUUID(); const token = randomUUID();
    await db.admin.query(`insert into public.closeout_bank_payouts(id,workspace_id,location_id,business_date,account_id,bank_id,connection_id,environment,state,gross_cents,refund_cents,fee_cents,net_cents,lease_token,lease_until)
      values($1,$3,$4,current_date,'acct_test','ba_test',$5,'production','no_payout',0,200,0,-200,null,null),
      ($2,$3,$4,current_date,'acct_test','ba_test',$5,'production','waiting',null,null,null,null,$6,now()+interval '2 minutes')`, [debt, next, workspaceId, location, control.connection_id, token]);
    const planned = (await db.admin.query("select public.wayne_update_bank_payout($1,$2,'plan',$3) value", [next, token, { gross: 1000, refunds: 0, fees: 30, net: 970, carry_net: -200 }])).rows[0].value;
    expect(Number(planned.net_cents)).toBe(770); expect(Number(planned.refund_cents)).toBe(200);
    expect((await db.admin.query("select offset_payout_id from public.closeout_bank_payouts where id=$1", [debt])).rows[0].offset_payout_id).toBe(next);
  });
});
