import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationFiles = ["20260908000000_phase0_foundation.sql", "20260908010000_phase1_public_menu.sql", "20260908020000_phase2_orders.sql", "20260908030000_phase3_admin_orders.sql", "20260908040000_phase4_front_pos.sql", "20260909050000_phase5_kitchen_printing.sql", "20260909060000_phase0_5_reliability_fixes.sql", "20260909070000_phase0_5_special_hours_carryover.sql", "20260910060000_phase6_reports.sql"];
const migrations = migrationFiles.map((file) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8"));
const ownerId = "46000000-0000-4000-8000-000000000001";
const cashierId = "46000000-0000-4000-8000-000000000002";
const categoryId = "46000000-0000-4000-8000-000000000010";
const itemId = "46000000-0000-4000-8000-000000000011";
const firstOrderId = "46000000-0000-4000-8000-000000000021";
const secondOrderId = "46000000-0000-4000-8000-000000000022";

describe("Phase 6 authoritative reporting", () => {
  const database = new PGlite();
  beforeAll(async () => {
    await database.exec(`create role anon nologin; create role authenticated nologin; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}'::jsonb); create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);`);
    for (const migration of migrations) await database.exec(migration);
    await database.exec(`
      insert into auth.users(id,email) values ('${ownerId}','owner@phase6.test'),('${cashierId}','cashier@phase6.test');
      update public.profiles set role_id=(select id from public.roles where code='owner') where id='${ownerId}';
      insert into public.menu_categories(id,name) values('${categoryId}','Pizza');
      insert into public.menu_items(id,category_id,name,base_price_cents) values('${itemId}','${categoryId}','Cheese Pizza',1000);
      insert into public.orders(id,order_number,source,fulfillment_type,status,payment_status,payment_method,subtotal_cents,discount_cents,delivery_fee_cents,tax_cents,tip_cents,total_cents,customer_name_snapshot,customer_phone_snapshot,pricing_snapshot,placed_at,idempotency_key) values
        ('${firstOrderId}','W900001','online','pickup','completed','paid','card',1000,100,0,50,0,950,'A Customer','+15085550101','{}','2026-03-09 04:30:00+00','phase6-first-order-key'),
        ('${secondOrderId}','W900002','pos','delivery','completed','paid','cash',2000,0,300,115,100,2515,'B Customer','+15085550102','{}','2026-03-09 05:30:00+00','phase6-second-order-key');
      insert into public.order_items(order_id,menu_item_id,item_name_snapshot,unit_price_cents,quantity,line_total_cents) values
        ('${firstOrderId}','${itemId}','Cheese Pizza',1000,1,1000),('${secondOrderId}','${itemId}','Cheese Pizza',2000,1,2000);
      insert into public.payments(id,order_id,provider,provider_payment_id,method,amount_cents,status,captured_at) values ('46000000-0000-4000-8000-000000000031','${firstOrderId}','manual','first','card',950,'captured','2026-03-09 04:30:00+00');
      insert into public.refunds(payment_id,order_id,amount_cents,reason,created_by_user_id,created_at) values ('46000000-0000-4000-8000-000000000031','${firstOrderId}',200,'Customer correction','${ownerId}','2026-03-09 06:00:00+00');
    `);
  }, 30_000);
  afterAll(async () => database.close());

  it("uses authoritative persisted totals, discounts, and refunds", async () => {
    const summary = await asOwner<{ order_count: number; gross_sales_cents: number; discount_cents: number; refund_cents: number; net_sales_cents: number }>(database, "public.wayne_report_summary('2026-03-08','2026-03-09')");
    expect(summary).toMatchObject({ order_count: 2, gross_sales_cents: 3565, discount_cents: 100, refund_cents: 200, net_sales_cents: 3265 });
    const daily = await asOwner<Array<{ service_date: string; order_count: number; net_sales_cents: number }>>(database, "public.wayne_report_daily_sales('2026-03-08','2026-03-09')");
    expect(daily).toMatchObject([{ service_date: "2026-03-08", order_count: 0, net_sales_cents: 0 }, { service_date: "2026-03-09", order_count: 2, net_sales_cents: 3265 }]);
  });

  it("retains category snapshots and excludes cancelled orders from sales and item reporting", async () => {
    await database.exec(`update public.menu_categories set name='Renamed category' where id='${categoryId}'; update public.orders set status='cancelled' where id='${secondOrderId}';`);
    const items = await asOwner<Array<{ category_name: string; quantity: number; sales_cents: number }>>(database, "public.wayne_report_items('2026-03-08','2026-03-09')");
    expect(items).toEqual([{ category_name: "Pizza", item_name: "Cheese Pizza", quantity: 1, sales_cents: 1000 }]);
    const summary = await asOwner<{ order_count: number; net_sales_cents: number }>(database, "public.wayne_report_summary('2026-03-08','2026-03-09')");
    expect(summary).toMatchObject({ order_count: 1, net_sales_cents: 750 });
  });

  it("denies report RPCs to staff without report permission", async () => {
    await expect(asOwner(database, "public.wayne_report_summary('2026-03-08','2026-03-09')", cashierId)).rejects.toThrow(/Report viewing permission required/);
  });

  it("uses the configured store timezone in every reporting boundary", () => {
    const migration = migrations.at(-1)!;
    expect(migration).toContain("settings.timezone into store_timezone");
    expect(migration.match(/at time zone store_timezone/g)).toHaveLength(12);
  });
});

async function asOwner<T>(database: PGlite, expression: string, userId = ownerId) { await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${userId}',true);`); try { const result = await database.query<{ result: T }>(`select ${expression} result`); await database.exec("rollback"); return result.rows[0]!.result; } catch (error) { await database.exec("rollback"); throw error; } }
