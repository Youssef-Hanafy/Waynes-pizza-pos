import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrations = [0, 1, 2, 3, 4].map((phase) => readFileSync(resolve(process.cwd(), "supabase/migrations", [
  "20260908000000_phase0_foundation.sql",
  "20260908010000_phase1_public_menu.sql",
  "20260908020000_phase2_orders.sql",
  "20260908030000_phase3_admin_orders.sql",
  "20260908040000_phase4_front_pos.sql",
][phase]!), "utf8"));
const ownerId = "47000000-0000-4000-8000-000000000001";
const cashierId = "47000000-0000-4000-8000-000000000002";
const itemId = "47000000-0000-4000-8000-000000000011";

describe("Phase 4 front POS database", () => {
  const database = new PGlite();
  beforeAll(async () => {
    await database.exec(`create role anon nologin; create role authenticated nologin; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb); create schema storage; create table storage.buckets (id text primary key, name text not null, public boolean not null default false, file_size_limit bigint, allowed_mime_types text[]); create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null);`);
    for (const migration of migrations) await database.exec(migration);
    await database.exec(`
      insert into auth.users (id,email,raw_user_meta_data) values ('${ownerId}','owner@phase4.test','{"display_name":"Owner"}'),('${cashierId}','cashier@phase4.test','{"display_name":"Cashier"}');
      update public.profiles set role_id=(select id from public.roles where code='owner') where id='${ownerId}';
      update public.store_settings set tax_rate_basis_points=625, delivery_fee_cents=300, delivery_postal_codes=array['01606'];
      insert into public.menu_categories (id,name,customer_visible) values ('47000000-0000-4000-8000-000000000010','Counter',false);
      insert into public.menu_items (id,category_id,name,base_price_cents,customer_visible,pos_visible) values ('${itemId}','47000000-0000-4000-8000-000000000010','Counter Pizza',1600,false,true);
    `);
  }, 30_000);
  afterAll(async () => database.close());

  it("shows POS-visible items to cashiers without making them public", async () => {
    const posMenu = await authenticatedCall<unknown[]>(database, cashierId, "public.wayne_pos_menu()");
    expect((posMenu[0] as { items: unknown[] }).items).toHaveLength(1);
    await database.exec("set role anon");
    const publicMenu = await database.query<{ result: { items: unknown[] }[] }>("select public.wayne_public_menu() result");
    await database.exec("reset role");
    expect(publicMenu.rows[0]!.result).toHaveLength(0);
  });

  it("creates an identified phone delivery and updates reproducible customer metrics", async () => {
    const result = await createOrder(database, cashierId, identifiedPayload("phase4-phone-order-001"));
    const duplicate = await createOrder(database, cashierId, identifiedPayload("phase4-phone-order-001"));
    expect(duplicate).toMatchObject({ id: result.id, duplicate: true });
    const order = await database.query<{ source: string; customer_id: string; total_cents: number }>(`select source,customer_id,total_cents from public.orders where id='${result.id}'`);
    expect(order.rows[0]?.source).toBe("phone");
    const customer = await database.query<{ order_count: number; lifetime_spend_cents: number; average_order_value_cents: number }>(`select order_count,lifetime_spend_cents,average_order_value_cents from public.customers where id='${order.rows[0]!.customer_id}'`);
    expect(customer.rows[0]).toEqual({ order_count: 1, lifetime_spend_cents: order.rows[0]!.total_cents, average_order_value_cents: order.rows[0]!.total_cents });
  });

  it("finds the customer by name, formatted phone, and order number", async () => {
    const order = await database.query<{ order_number: string }>("select order_number from public.orders where source='phone' limit 1");
    for (const search of ["Pat Customer", "(508) 555-0144", order.rows[0]!.order_number]) {
      const results = await authenticatedCall<unknown[]>(database, cashierId, `public.wayne_pos_customer_search('${search}')`);
      expect(results).toHaveLength(1);
    }
  });

  it("creates an anonymous walk-in in the exact same orders model", async () => {
    const result = await createOrder(database, cashierId, walkInPayload("phase4-walkin-order-01"));
    const order = await database.query<{ customer_id: string | null; source: string; fulfillment_type: string; customer_name_snapshot: string }>(`select customer_id,source,fulfillment_type,customer_name_snapshot from public.orders where id='${result.id}'`);
    expect(order.rows[0]).toEqual({ customer_id: null, source: "pos", fulfillment_type: "pickup", customer_name_snapshot: "Walk-in" });
  });

  it("denies manual discounts to cashiers and audits an owner discount", async () => {
    const discounted = { ...walkInPayload("phase4-discount-key-001"), manual_discount_type: "percent", manual_discount_value: 1000, manual_discount_reason: "Owner service recovery" };
    await expect(createOrder(database, cashierId, discounted)).rejects.toThrow(/Manager discount permission required/);
    const result = await createOrder(database, ownerId, discounted);
    const audit = await database.query<{ discount_cents: number; actor_user_id: string; reason: string }>(`select order_row.discount_cents,event.actor_user_id,event.metadata->>'reason' reason from public.orders order_row join public.order_events event on event.order_id=order_row.id and event.event_type='order.discount_applied' where order_row.id='${result.id}'`);
    expect(audit.rows[0]).toEqual({ discount_cents: 160, actor_user_id: ownerId, reason: "Owner service recovery" });
  });

  it("rejects delivery addresses outside the configured postal codes", async () => {
    const payload = identifiedPayload("phase4-bad-zone-key-01"); payload.address.postal_code = "02110";
    await expect(createOrder(database, cashierId, payload)).rejects.toThrow(/outside the configured delivery area/);
  });
});

function baseItems() { return [{ menu_item_id: itemId, variant_id: null, quantity: 1, special_instructions: "Well done", modifiers: [] }]; }
function walkInPayload(idempotency_key: string) { return { idempotency_key, customer_mode: "walk_in", customer_id: "", source: "pos", fulfillment_type: "pickup", payment_method: "test_manual", first_name: "", last_name: "", phone: "", email: "", address_id: "", address: { address1: "", address2: "", city: "", state: "", postal_code: "", delivery_instructions: "" }, promo_code: "", manual_discount_type: "", manual_discount_value: 0, manual_discount_reason: "", tip_cents: 0, special_instructions: "Counter", items: baseItems() }; }
function identifiedPayload(idempotency_key: string) { return { ...walkInPayload(idempotency_key), customer_mode: "identified", source: "phone", fulfillment_type: "delivery", first_name: "Pat", last_name: "Customer", phone: "508-555-0144", address: { address1: "10 Main St", address2: "", city: "Worcester", state: "MA", postal_code: "01606", delivery_instructions: "Side door" } }; }
async function createOrder(database: PGlite, userId: string, payload: Record<string, unknown>) { return authenticatedCall<{ id: string; duplicate: boolean }>(database, userId, `public.wayne_create_pos_order('${JSON.stringify(payload).replaceAll("'", "''")}'::jsonb)`, true); }
async function authenticatedCall<T>(database: PGlite, userId: string, expression: string, commit = false) { await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${userId}',true);`); try { const result = await database.query<{ result: T }>(`select ${expression} result`); await database.exec(commit ? "commit" : "rollback"); return result.rows[0]!.result; } catch (error) { await database.exec("rollback"); throw error; } }
