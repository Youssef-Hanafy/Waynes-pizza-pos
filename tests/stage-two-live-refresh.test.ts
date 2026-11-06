import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTipPostgres, ownerId, workspaceId } from "./helpers/tip-postgres";

describe("Stage 2 notifications and CRM delivery (real PostgreSQL)", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  beforeAll(async () => { db = await startTipPostgres(); }, 120_000);
  afterAll(async () => { await db?.stop(); });
  async function auth(sql: string, args: unknown[] = []) {
    await db.admin.query("begin; set local role authenticated");
    await db.admin.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
    try { const result = await db.admin.query(sql, args); await db.admin.query("commit"); return result; }
    catch (error) { await db.admin.query("rollback"); throw error; }
  }
  async function revision() {
    return Number((await db.admin.query("select revision from public.pos_refresh_signals where topic='display' and signal_key='Stage Two'")).rows[0]?.revision ?? 0);
  }
  it("notifies real screen changes and answers, but never heartbeat/read feedback loops", async () => {
    await auth("select public.wayne_display_publish('Stage Two',$1,'publisher-a',true)", [{ phase: "tip", request_id: "tip-1" }]);
    const first = await revision(); expect(first).toBe(1);
    await auth("select public.wayne_display_read('Stage Two')");
    await auth("select public.wayne_display_publish('Stage Two',$1,'publisher-a',false)", [{ phase: "tip", request_id: "tip-1" }]);
    expect(await revision()).toBe(first);
    await auth("select public.wayne_display_respond('Stage Two',$1)", [{ request_id: "tip-1", kind: "tip", tip_cents: 500 }]);
    expect(await revision()).toBe(first + 1);
    const heartbeat = await auth("select public.wayne_display_publish('Stage Two',$1,'publisher-a',false) result", [{ phase: "tip", request_id: "tip-1" }]);
    expect(heartbeat.rows[0].result.response.tip_cents).toBe(500);
    expect(await revision()).toBe(first + 1);
    await auth("select public.wayne_display_publish('Stage Two',$1,'publisher-b',false)", [{ phase: "idle" }]);
    expect(await revision()).toBe(first + 1); // other register cannot blank an active request
    const stale = await auth("select public.wayne_display_respond('Stage Two',$1) result", [{ request_id: "wrong", kind: "tip", tip_cents: 100 }]);
    expect(stale.rows[0].result.accepted).toBe(false);
    await db.admin.query("update public.pos_customer_displays set seen_at=now()-interval '45 seconds' where display_key='Stage Two'");
    const healthy = await auth("select public.wayne_display_publish('Stage Two',$1,'publisher-a',false) result", [{ phase: "tip", request_id: "tip-1" }]);
    expect(healthy.rows[0].result.screen_online).toBe(true);
  });
  it("protects notification contents and publishes menu/settings edits", async () => {
    const before = Number((await db.admin.query("select revision from public.pos_refresh_signals where workspace_id=$1 and topic='runtime'", [workspaceId])).rows[0].revision);
    await db.admin.query("update public.menu_items set name=name||' updated' where id='79000000-0000-4000-8000-000000000003'");
    const rows = await auth("select * from public.pos_refresh_signals where workspace_id=$1 and topic='runtime'", [workspaceId]);
    expect(Number(rows.rows[0].revision)).toBeGreaterThan(before);
    expect(Object.keys(rows.rows[0]).sort()).toEqual(["revision", "signal_key", "topic", "workspace_id"]);
    const outsider = await db.connect(); await outsider.query("set role authenticated");
    expect((await outsider.query("select * from public.pos_refresh_signals")).rows).toEqual([]);
    await expect(outsider.query("insert into public.pos_refresh_signals(workspace_id,topic) values($1,'runtime')", [workspaceId])).rejects.toThrow("permission denied");
  });
  it("sends consent promptly, collects within its lease, and waits to send routine data", async () => {
    await db.admin.query(`
      create schema net;
      create table net.test_requests(id bigint generated always as identity primary key, body jsonb, headers jsonb);
      create table net._http_response(id bigint primary key, status_code integer, content text, timed_out boolean, error_msg text);
      create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 1000)
      returns bigint language sql as $$ insert into net.test_requests(body,headers) values(body,headers) returning id $$;
      insert into public.integration_destinations(id,endpoint_url,signing_secret) values('hanafy','https://crm.example.invalid/events',repeat('x',40));
      insert into public.customers(id,first_name,last_name,phone_normalized,sms_marketing_opt_in)
        values('79000000-0000-4000-8000-000000000090','Consent','test','+15085550199',true);
    `);
    expect((await db.admin.query("select count(*)::int n from net.test_requests")).rows[0].n).toBe(0);
    await db.admin.query("update public.customers set sms_marketing_opt_in=false where id='79000000-0000-4000-8000-000000000090'");
    const requests = (await db.admin.query("select * from net.test_requests")).rows;
    expect(requests).toHaveLength(1);
    expect(requests[0].body.event_type).toBe("customer.consent.changed");
    expect(requests[0].body.data.sms_marketing_opt_in).toBe(false);
    expect(requests[0].headers["x-waynes-signature"]).toMatch(/^sha256=/);
    await db.admin.query("insert into net._http_response values($1,200,'ok',false,null)", [requests[0].id]);
    await db.admin.query("select public.wayne_hanafy_delivery_maintenance()");
    expect((await db.admin.query("select status from public.integration_outbox where event_type='customer.consent.changed'")).rows[0].status).toBe("delivered");
    expect((await db.admin.query("select count(*)::int n from net.test_requests")).rows[0].n).toBe(1); // maintenance did not flush routine data
    await db.admin.query("select public.wayne_dispatch_hanafy_outbox(50)");
    const older = (await db.admin.query("select body from net.test_requests order by id desc limit 1")).rows[0].body;
    expect(older.event_type).not.toBe("customer.consent.changed");
    expect(older.data.sms_marketing_opt_in).toBe(false); // delayed snapshot cannot restore consent
  });
  it("orders consent after an in-flight snapshot and retries HTTP failures durably", async () => {
    await db.admin.query("update public.customers set email_marketing_opt_in=true where id='79000000-0000-4000-8000-000000000090'");
    expect((await db.admin.query("select count(*)::int n from net.test_requests")).rows[0].n).toBe(2); // previous routine send still in flight
    await db.admin.query("insert into net._http_response select max(id),200,'ok',false,null from net.test_requests; select public.wayne_hanafy_delivery_maintenance()");
    expect((await db.admin.query("select count(*)::int n from net.test_requests")).rows[0].n).toBe(3);
    await db.admin.query("insert into net._http_response select max(id),503,'busy',false,null from net.test_requests; select public.wayne_hanafy_delivery_maintenance()");
    const failed = (await db.admin.query("select * from public.integration_outbox where status='failed'")).rows[0];
    expect(failed.attempts).toBe(1); expect(failed.last_error).toContain("503");
    await db.admin.query("update public.integration_outbox set next_attempt_at=now() where id=$1", [failed.id]);
    // The maintenance pass may already have started the next hourly-cohort
    // snapshot after observing the failure. Acknowledge it before the retry.
    await db.admin.query("insert into net._http_response select id,200,'ok',false,null from net.test_requests where id not in (select id from net._http_response)");
    await db.admin.query("select public.wayne_hanafy_delivery_maintenance()");
    const retry = (await db.admin.query("select body from net.test_requests order by id desc limit 1")).rows[0].body;
    expect(retry.event_id).toBe(failed.event_id);
  });
});
