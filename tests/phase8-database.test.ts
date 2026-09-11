import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const files = ["20260908000000_phase0_foundation.sql", "20260908010000_phase1_public_menu.sql", "20260908020000_phase2_orders.sql", "20260908030000_phase3_admin_orders.sql", "20260908040000_phase4_front_pos.sql", "20260909050000_phase5_kitchen_printing.sql", "20260909060000_phase0_5_reliability_fixes.sql", "20260909070000_phase0_5_special_hours_carryover.sql", "20260910060000_phase6_reports.sql", "20260910070000_phase7_customer_intelligence.sql", "20260911080000_phase6_7_audit_remediation.sql", "20260912080000_phase8_hanafy_outbox.sql"];
const migrations = files.map((file) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8"));
const ownerId = "49000000-0000-4000-8000-000000000001";
const cashierId = "49000000-0000-4000-8000-000000000002";
const customerId = "49000000-0000-4000-8000-000000000010";

describe("Phase 8 Hanafy transactional outbox", () => {
  const database = new PGlite();
  beforeAll(async () => {
    await database.exec(`create role anon nologin; create role authenticated nologin; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}'::jsonb); create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);`);
    for (const migration of migrations) await database.exec(migration);
    await database.exec(`insert into auth.users(id,email) values('${ownerId}','owner@phase8.test'),('${cashierId}','cashier@phase8.test'); update public.profiles set role_id=(select id from public.roles where code='owner') where id='${ownerId}'; insert into public.integration_destinations(id,endpoint_url,business_id,signing_secret) values('hanafy','https://hanafy.test/events','waynes-pizza','01234567890123456789012345678901');`);
  }, 30_000);
  afterAll(async () => database.close());

  it("creates a complete, immutable envelope in the same customer transaction", async () => {
    await database.exec(`insert into public.customers(id,first_name,last_name,phone_normalized) values('${customerId}','Outbox','Customer','+15085550101');`);
    const events = await database.query<{ event_id: string; event_type: string; payload: { event_id: string; source: string; business_id: string; version: number; data: { customer_id: string } } }>(`select event_id,event_type,payload from public.integration_outbox order by created_at`);
    expect(events.rows.some((event) => event.event_type === "customer.created" && event.payload.event_id === event.event_id && event.payload.source === "waynes-pos" && event.payload.business_id === "waynes-pizza" && event.payload.version === 1 && event.payload.data.customer_id === customerId)).toBe(true);
  });

  it("persists failures, backs off, and safely replays the same event identity", async () => {
    const claim = await database.query<{ job: { id: string; event_id: string; lease_token: string; attempts: number } }>(`select public.wayne_claim_hanafy_outbox('phase8-test') job`);
    const job = claim.rows[0]!.job;
    expect(job.attempts).toBe(1);
    await database.query(`select public.wayne_finish_hanafy_outbox('${job.id}','${job.lease_token}',false,503,'temporary outage','Hanafy unavailable')`);
    const failed = await database.query<{ status: string; attempts: number; last_error: string; next_attempt_at: string }>(`select status,attempts,last_error,next_attempt_at from public.integration_outbox where id='${job.id}'`);
    expect(failed.rows[0]).toMatchObject({ status: "failed", attempts: 1, last_error: "Hanafy unavailable" });
    const logs = await database.query<{ request_status: string; response_code: number }>(`select request_status,response_code from public.integration_delivery_logs where outbox_id='${job.id}'`);
    expect(logs.rows[0]).toEqual({ request_status: "failed", response_code: 503 });
    await asOwner(database, `public.wayne_replay_hanafy_outbox('${job.id}')`);
    const replay = await database.query<{ event_id: string; status: string }>(`select event_id,status from public.integration_outbox where id='${job.id}'`);
    expect(replay.rows[0]).toEqual({ event_id: job.event_id, status: "pending" });
  });

  it("keeps worker RPCs internal and denies replay to a cashier", async () => {
    const outbox = await database.query<{ id: string }>("select id from public.integration_outbox limit 1");
    await expect(asOwner(database, `public.wayne_replay_hanafy_outbox('${outbox.rows[0]!.id}')`, cashierId)).rejects.toThrow(/Integration management permission required/);
    await expect(asOwner(database, "public.wayne_claim_hanafy_outbox('cashier')", cashierId)).rejects.toThrow(/permission denied/i);
  });
});

async function asOwner<T>(database: PGlite, expression: string, userId = ownerId) { await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${userId}',true);`); try { const result = await database.query<{ result: T }>(`select ${expression} result`); await database.exec("commit"); return result.rows[0]!.result; } catch (error) { await database.exec("rollback"); throw error; } }
