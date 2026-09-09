import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationFiles = [
  "20260908000000_phase0_foundation.sql",
  "20260908010000_phase1_public_menu.sql",
  "20260908020000_phase2_orders.sql",
  "20260908030000_phase3_admin_orders.sql",
];
const migrations = migrationFiles.map((file) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8"));
const ownerId = "45000000-0000-4000-8000-000000000001";
const cashierId = "45000000-0000-4000-8000-000000000002";
const itemId = "45000000-0000-4000-8000-000000000011";

describe("Phase 3 admin order reporting", () => {
  const database = new PGlite();

  beforeAll(async () => {
    await database.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
      create schema storage;
      create table storage.buckets (id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null);
    `);
    for (const migration of migrations) await database.exec(migration);
    await database.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ('${ownerId}', 'owner@phase3.test', '{"display_name":"Owner"}'),
        ('${cashierId}', 'cashier@phase3.test', '{"display_name":"Cashier"}');
      update public.profiles set role_id = (select id from public.roles where code = 'owner') where id = '${ownerId}';
      update public.store_settings set business_hours = '{"sunday":{"closed":false,"open":"00:00","close":"23:59"},"monday":{"closed":false,"open":"00:00","close":"23:59"},"tuesday":{"closed":false,"open":"00:00","close":"23:59"},"wednesday":{"closed":false,"open":"00:00","close":"23:59"},"thursday":{"closed":false,"open":"00:00","close":"23:59"},"friday":{"closed":false,"open":"00:00","close":"23:59"},"saturday":{"closed":false,"open":"00:00","close":"23:59"}}';
      insert into public.menu_categories (id, name) values ('45000000-0000-4000-8000-000000000010', 'Pizza');
      insert into public.menu_items (id, category_id, name, base_price_cents) values ('${itemId}', '45000000-0000-4000-8000-000000000010', 'Cheese Pizza', 1500);
    `);
    const first = await createOrder(database, "phase3-order-key-0001", "Alice", "Adams", "508-555-0101", "pickup");
    const second = await createOrder(database, "phase3-order-key-0002", "Bob", "Baker", "508-555-0102", "delivery");
    await database.exec(`update public.orders set placed_at = case id when '${first.id}' then '2026-03-15 16:00:00+00'::timestamptz else '2026-03-16 17:00:00+00'::timestamptz end where id in ('${first.id}', '${second.id}')`);
  }, 30_000);

  afterAll(async () => database.close());

  it("finds orders by number, customer name, phone, and Wayne business date", async () => {
    const order = await database.query<{ order_number: string }>("select order_number from public.orders where customer_name_snapshot = 'Alice Adams'");
    for (const search of [order.rows[0]!.order_number, "Alice", "(508) 555-0101"]) {
      const result = await adminCall<{ total_count: number }>(database, ownerId, `public.wayne_admin_orders('${search.replaceAll("'", "''")}', null, null, null, null, null, null, 100, 0)`);
      expect(result.total_count).toBe(1);
    }
    const dateResult = await adminCall<{ total_count: number }>(database, ownerId, "public.wayne_admin_orders(null, '2026-03-15', '2026-03-15', null, null, null, null, 100, 0)");
    expect(dateResult.total_count).toBe(1);
  });

  it("returns calendar counts and totals that match stored orders", async () => {
    const calendar = await adminCall<Array<{ service_date: string; order_count: number; active_total_cents: number }>>(database, ownerId, "public.wayne_admin_order_calendar('2026-03-01')");
    expect(calendar.map((day) => day.service_date)).toEqual(["2026-03-15", "2026-03-16"]);
    expect(calendar.reduce((sum, day) => sum + day.order_count, 0)).toBe(2);
    const stored = await database.query<{ total: number }>("select sum(total_cents)::int total from public.orders where status <> 'cancelled'");
    expect(calendar.reduce((sum, day) => sum + day.active_total_cents, 0)).toBe(stored.rows[0]!.total);
  });

  it("returns nested item snapshots and timeline events for detail", async () => {
    const order = await database.query<{ id: string }>("select id from public.orders order by placed_at limit 1");
    const detail = await adminCall<{ order_number: string; items: { item_name_snapshot: string }[]; events: { event_type: string }[] }>(database, ownerId, `public.wayne_admin_order_detail('${order.rows[0]!.id}')`);
    expect(detail.order_number).toMatch(/^W\d{6}$/);
    expect(detail.items[0]?.item_name_snapshot).toBe("Cheese Pizza");
    expect(detail.events[0]?.event_type).toBe("order.placed");
  });

  it("denies all Phase 3 reporting RPCs to a cashier", async () => {
    await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${cashierId}', true);`);
    await expect(database.query("select public.wayne_admin_orders() result")).rejects.toThrow(/permission required/i);
    await database.exec("rollback");
  });
});

async function createOrder(database: PGlite, key: string, first: string, last: string, phone: string, fulfillment: "pickup" | "delivery") {
  const payload = { idempotency_key: key, fulfillment_type: fulfillment, first_name: first, last_name: last, phone, email: "", sms_opt_in: false, email_opt_in: false, tip_cents: 0, special_instructions: "", address: fulfillment === "delivery" ? { address1: "93 West Boylston St", address2: "", city: "Worcester", state: "MA", postal_code: "01606", delivery_instructions: "" } : {}, items: [{ menu_item_id: itemId, variant_id: null, quantity: 1, special_instructions: "", modifiers: [] }] };
  await database.exec("set role anon");
  const result = await database.query<{ result: { id: string } }>(`select public.wayne_create_test_order('${JSON.stringify(payload).replaceAll("'", "''")}'::jsonb) result`);
  await database.exec("reset role");
  return result.rows[0]!.result;
}

async function adminCall<T>(database: PGlite, userId: string, expression: string) {
  await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${userId}', true);`);
  const result = await database.query<{ result: T }>(`select ${expression} result`);
  await database.exec("rollback");
  return result.rows[0]!.result;
}
