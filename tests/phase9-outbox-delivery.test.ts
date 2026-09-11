import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signHanafyEnvelope } from "@/lib/integrations/hanafy";

const files = ["20260908000000_phase0_foundation.sql", "20260908010000_phase1_public_menu.sql", "20260908020000_phase2_orders.sql", "20260908030000_phase3_admin_orders.sql", "20260908040000_phase4_front_pos.sql", "20260909050000_phase5_kitchen_printing.sql", "20260909060000_phase0_5_reliability_fixes.sql", "20260909070000_phase0_5_special_hours_carryover.sql", "20260910060000_phase6_reports.sql", "20260910070000_phase7_customer_intelligence.sql", "20260911080000_phase6_7_audit_remediation.sql", "20260912080000_phase8_hanafy_outbox.sql", "20260913080000_phase9_outbox_database_delivery.sql"];
const migrations = files.map((file) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8"));
const secret = "phase9-delivery-secret-0123456789abcdef";
const customerId = "59000000-0000-4000-8000-000000000010";

type Job = { id: string; lease_token: string; attempts: number; status: string };
type Captured = { id: number; url: string; body: Record<string, unknown>; body_text: string; headers: Record<string, string> };

describe("Phase 9 database-native Hanafy outbox delivery", () => {
  const database = new PGlite({ extensions: { pgcrypto } });

  beforeAll(async () => {
    await database.exec(`create role anon nologin; create role authenticated nologin; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}'::jsonb); create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);`);
    for (const migration of migrations) await database.exec(migration);
    await database.exec(`insert into public.integration_destinations(id,endpoint_url,business_id,signing_secret) values('hanafy','https://crm.test/api/v1/integrations/waynes/events','waynes-pizza','${secret}');`);
  }, 60_000);
  afterAll(async () => database.close());

  it("signs exactly like the Next.js worker", async () => {
    const timestamp = "2026-09-11T12:00:00.000Z";
    const body = JSON.stringify({ event_id: "e1", note: "Wayne's “special” 🍕" });
    const result = await database.query<{ signature: string }>("select public.wayne_sign_hanafy_body($1,$2,$3) signature", [secret, timestamp, body]);
    expect(result.rows[0]!.signature).toBe(signHanafyEnvelope(secret, timestamp, body));
  });

  it("reports cleanly when pg_net is unavailable instead of claiming events", async () => {
    await database.exec(`insert into public.customers(id,first_name,last_name,phone_normalized) values('${customerId}','Delivery','Tester','+15085550199');`);
    const result = await database.query<{ result: { ok: boolean; reason: string } }>("select public.wayne_dispatch_hanafy_outbox(5) result");
    expect(result.rows[0]!.result).toEqual({ ok: false, reason: "pg_net is not installed" });
    const pending = await database.query<{ count: number }>("select count(*)::int count from public.integration_outbox where status='pending'");
    expect(pending.rows[0]!.count).toBeGreaterThan(0);
  });

  it("reclaims an expired processing lease and logs the lost attempt", async () => {
    const claim = await database.query<{ job: Job }>("select public.wayne_claim_hanafy_outbox('crashed-worker') job");
    const lost = claim.rows[0]!.job;
    await database.exec(`update public.integration_outbox set lease_expires_at=now()-interval '1 second' where id='${lost.id}'`);
    const reclaim = await database.query<{ job: Job }>("select public.wayne_claim_hanafy_outbox('next-worker') job");
    const job = reclaim.rows[0]!.job;
    expect(job.id).toBe(lost.id);
    expect(job.attempts).toBe(2);
    expect(job.lease_token).not.toBe(lost.lease_token);
    const logs = await database.query<{ attempt_number: number; request_status: string; error_message: string }>(`select attempt_number,request_status,error_message from public.integration_delivery_logs where outbox_id='${lost.id}'`);
    expect(logs.rows).toEqual([{ attempt_number: 1, request_status: "failed", error_message: "Delivery lease expired before a result was recorded." }]);
    await expect(database.query(`select public.wayne_finish_hanafy_outbox('${lost.id}','${lost.lease_token}',true)`)).rejects.toThrow(/Stale integration outbox lease/);
    await database.query(`select public.wayne_finish_hanafy_outbox('${job.id}','${job.lease_token}',false,503,null,'test reset')`);
    await database.exec(`update public.integration_outbox set next_attempt_at=now() where id='${job.id}'`);
  });

  it("dispatches signed requests through pg_net and records 2xx / non-2xx results", async () => {
    await database.exec(`
      create schema net;
      create table net.captured_requests(id bigserial primary key, url text, body jsonb, body_text text, headers jsonb);
      create table net._http_response(id bigint primary key, status_code integer, content text, timed_out boolean, error_msg text, created timestamptz default now());
      create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
      returns bigint language sql as $$ insert into net.captured_requests(url,body,body_text,headers) values(url,body,body::text,headers) returning id $$;
    `);
    await database.exec("insert into public.customers(first_name,last_name,phone_normalized) values('Second','Tester','+15085550198')");
    const before = await database.query<{ count: number }>("select count(*)::int count from public.integration_outbox where status in ('pending','failed')");
    const dispatch = await database.query<{ result: { ok: boolean; dispatched: number } }>("select public.wayne_dispatch_hanafy_outbox(50) result");
    expect(dispatch.rows[0]!.result.dispatched).toBe(before.rows[0]!.count);

    const requests = await database.query<Captured>("select id,url,body,body_text,headers from net.captured_requests order by id");
    for (const request of requests.rows) {
      expect(request.url).toBe("https://crm.test/api/v1/integrations/waynes/events");
      expect(request.headers["x-waynes-event-id"]).toBe(request.body.event_id);
      expect(request.headers["x-waynes-signature"]).toBe(signHanafyEnvelope(secret, request.headers["x-waynes-timestamp"]!, request.body_text));
    }

    const [first, second] = requests.rows;
    await database.exec(`insert into net._http_response(id,status_code,content) values(${first!.id},202,'{"ok":true}'),(${second!.id},503,'down')`);
    const collect = await database.query<{ result: { delivered: number; failed: number } }>("select public.wayne_collect_hanafy_responses() result");
    expect(collect.rows[0]!.result).toMatchObject({ delivered: 1, failed: 1 });

    const rows = await database.query<{ event_id: string; status: string; http_request_id: string | null; last_error: string | null }>("select event_id,status,http_request_id,last_error from public.integration_outbox where event_id::text in ($1,$2) order by status", [String(first!.body.event_id), String(second!.body.event_id)]);
    expect(rows.rows).toEqual([
      { event_id: first!.body.event_id, status: "delivered", http_request_id: null, last_error: null },
      { event_id: second!.body.event_id, status: "failed", http_request_id: null, last_error: "Hanafy returned HTTP 503." },
    ]);
  });

  it("puts the segment name on segment enter/exit events", async () => {
    const segment = await database.query<{ id: string; name: string }>("select id,name from public.customer_segments where name='VIP'");
    await database.exec(`insert into public.customer_events(customer_id,event_type,segment_id) values('${customerId}','customer.segment.exited','${segment.rows[0]!.id}')`);
    const event = await database.query<{ payload: { data: { segment: { id: string; name: string }; segment_id: string } } }>("select payload from public.integration_outbox where event_type='customer.segment.exited' order by created_at desc limit 1");
    expect(event.rows[0]!.payload.data.segment).toEqual({ id: segment.rows[0]!.id, name: "VIP" });
  });

  it("keeps delivery functions away from browser roles", async () => {
    await database.exec("begin; set local role authenticated;");
    await expect(database.query("select public.wayne_dispatch_hanafy_outbox(1)")).rejects.toThrow(/permission denied/i);
    await database.exec("rollback");
    await database.exec("begin; set local role authenticated;");
    await expect(database.query("select public.wayne_customer_hanafy_properties(gen_random_uuid())")).rejects.toThrow(/permission denied/i);
    await database.exec("rollback");
  });
});
