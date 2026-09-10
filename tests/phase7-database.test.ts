import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const files = ["20260908000000_phase0_foundation.sql", "20260908010000_phase1_public_menu.sql", "20260908020000_phase2_orders.sql", "20260908030000_phase3_admin_orders.sql", "20260908040000_phase4_front_pos.sql", "20260909050000_phase5_kitchen_printing.sql", "20260909060000_phase0_5_reliability_fixes.sql", "20260909070000_phase0_5_special_hours_carryover.sql", "20260910060000_phase6_reports.sql", "20260910070000_phase7_customer_intelligence.sql"];
const migrations = files.map((file) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8"));
const ownerId = "48000000-0000-4000-8000-000000000001";
const cashierId = "48000000-0000-4000-8000-000000000002";
const customerId = "48000000-0000-4000-8000-000000000010";

describe("Phase 7 customer intelligence and segments", () => {
  const database = new PGlite();
  beforeAll(async () => {
    await database.exec(`create role anon nologin; create role authenticated nologin; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}'::jsonb); create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);`);
    for (const migration of migrations) await database.exec(migration);
    await database.exec(`insert into auth.users(id,email) values ('${ownerId}','owner@phase7.test'),('${cashierId}','cashier@phase7.test'); update public.profiles set role_id=(select id from public.roles where code='owner') where id='${ownerId}'; insert into public.customers(id,first_name,last_name,phone_normalized) values('${customerId}','Segment','Customer','+15085550101');`);
    await insertOrder(database, "48000000-0000-4000-8000-000000000021", "W700001", "2026-01-01 17:00:00+00", 60000);
    await insertOrder(database, "48000000-0000-4000-8000-000000000022", "W700002", "2026-01-15 17:00:00+00", 50000);
    await database.exec(`delete from public.customer_events where customer_id='${customerId}'; delete from public.customer_segment_memberships where customer_id='${customerId}';`);
  }, 30_000);
  afterAll(async () => database.close());

  it("rebuilds reproducible qualifying-order metrics and evaluates editable VIP/high spender rules", async () => {
    await asOwner(database, `public.wayne_rebuild_customer_metrics('${customerId}')`);
    const metrics = await database.query<{ order_count: number; lifetime_spend_cents: number; average_order_value_cents: number }>(`select order_count,lifetime_spend_cents,average_order_value_cents from public.customers where id='${customerId}'`);
    expect(metrics.rows[0]).toEqual({ order_count: 2, lifetime_spend_cents: 110000, average_order_value_cents: 55000 });
    await database.exec(`delete from public.customer_events where customer_id='${customerId}'; delete from public.customer_segment_memberships where customer_id='${customerId}';`);
    await database.exec(`update public.customer_segments set rules_json='{"all":[{"field":"lifetime_spend_cents","operator":">=","value":100000},{"field":"order_count","operator":">=","value":2}]}'::jsonb where name='VIP'`);
    await asOwner(database, `public.wayne_run_nightly_inactivity_evaluator('2026-01-20 12:00:00+00')`);
    const active = await database.query<{ name: string }>(`select s.name from public.customer_segment_memberships m join public.customer_segments s on s.id=m.segment_id where m.customer_id='${customerId}' and m.active order by s.sort_order`);
    expect(active.rows.map((row) => row.name)).toEqual(["VIP", "High spender"]);
  });

  it("creates exactly one membership transition event and supports 60/90-day inactivity", async () => {
    await asOwner(database, `public.wayne_run_nightly_inactivity_evaluator('2026-04-20 12:00:00+00')`);
    await asOwner(database, `public.wayne_run_nightly_inactivity_evaluator('2026-04-20 12:00:00+00')`);
    const active = await database.query<{ name: string }>(`select s.name from public.customer_segment_memberships m join public.customer_segments s on s.id=m.segment_id where m.customer_id='${customerId}' and m.active order by s.sort_order`);
    expect(active.rows.map((row) => row.name)).toEqual(["VIP", "High spender", "30-day inactive", "60-day inactive", "90-day inactive"]);
    const events = await database.query<{ event_type: string; name: string }>(`select event.event_type,segment.name from public.customer_events event join public.customer_segments segment on segment.id=event.segment_id where event.customer_id='${customerId}' and event.event_type like 'customer.segment.%' order by event.occurred_at,event.id`);
    expect(events.rows.filter((event) => event.name === "60-day inactive" && event.event_type === "customer.segment.entered")).toEqual([{ event_type: "customer.segment.entered", name: "60-day inactive" }]);
    expect(events.rows.filter((event) => event.name === "90-day inactive" && event.event_type === "customer.segment.entered")).toHaveLength(1);
  });

  it("exits inactive segments exactly once when a qualifying new order arrives", async () => {
    await insertOrder(database, "48000000-0000-4000-8000-000000000023", "W700003", "2026-04-20 13:00:00+00", 1000);
    await asOwner(database, `public.wayne_rebuild_customer_metrics('${customerId}')`);
    await asOwner(database, `public.wayne_run_nightly_inactivity_evaluator('2026-04-20 14:00:00+00')`);
    const inactive = await database.query<{ count: number }>(`select count(*)::int count from public.customer_segment_memberships m join public.customer_segments s on s.id=m.segment_id where m.customer_id='${customerId}' and m.active and s.name like '%inactive'`);
    expect(inactive.rows[0]!.count).toBe(0);
    const exits = await database.query<{ count: number }>(`select count(*)::int count from public.customer_events event join public.customer_segments s on s.id=event.segment_id where event.customer_id='${customerId}' and event.event_type='customer.segment.exited' and s.name='30-day inactive'`);
    expect(exits.rows[0]!.count).toBe(1);
  });

  it("denies customer intelligence to staff without permission", async () => {
    await expect(asOwner(database, "public.wayne_admin_customers()", cashierId)).rejects.toThrow(/Customer viewing permission required/);
    await expect(asOwner(database, "public.wayne_run_nightly_inactivity_evaluator()", cashierId)).rejects.toThrow(/Segment management permission required/);
  });
});

async function insertOrder(database: PGlite, id: string, number: string, placedAt: string, total: number) { await database.exec(`insert into public.orders(id,order_number,customer_id,source,fulfillment_type,status,payment_status,payment_method,subtotal_cents,discount_cents,delivery_fee_cents,tax_cents,tip_cents,total_cents,customer_name_snapshot,customer_phone_snapshot,pricing_snapshot,placed_at,idempotency_key) values('${id}','${number}','${customerId}','online','pickup','completed','paid','card',${total},0,0,0,0,${total},'Segment Customer','+15085550101','{}','${placedAt}','phase7-${number}-idempotency')`); }
async function asOwner<T>(database: PGlite, expression: string, userId = ownerId) { await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${userId}',true);`); try { const result = await database.query<{ result: T }>(`select ${expression} result`); await database.exec("commit"); return result.rows[0]!.result; } catch (error) { await database.exec("rollback"); throw error; } }
