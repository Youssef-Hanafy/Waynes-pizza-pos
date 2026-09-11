import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = resolve(process.cwd(), "supabase/migrations");
const remediationFile = "20260914080000_phase0_8_audit_remediation.sql";
const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
const remediation = readFileSync(resolve(directory, remediationFile), "utf8");

const ownerId = "58000000-0000-4000-8000-000000000001";
const managerId = "58000000-0000-4000-8000-000000000002";
const cashierId = "58000000-0000-4000-8000-000000000003";
const kitchenId = "58000000-0000-4000-8000-000000000004";
const newcomerId = "58000000-0000-4000-8000-000000000005";
const categoryId = "58000000-0000-4000-8000-000000000010";
const itemId = "58000000-0000-4000-8000-000000000011";
const hours = `{${["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].map((day) => `"${day}":{"closed":false,"open":"00:00","close":"23:59"}`).join(",")}}`;

type Role = "anon" | "authenticated" | "service_role";
type OrderResult = { id: string; order_number: string; duplicate: boolean };

describe("Phase 0–8 audit remediation", () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  let sequence = 0;

  async function run<T>(role: Role, userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
    await database.exec(`begin; set local role ${role}; select set_config('request.jwt.claim.sub','${userId ?? ""}',true);`);
    try {
      const result = await database.query<T>(sql, params);
      await database.exec("commit");
      return result.rows;
    } catch (error) {
      await database.exec("rollback");
      throw error;
    }
  }
  const call = async <T>(role: Role, userId: string | null, expression: string, params: unknown[] = []) =>
    (await run<{ result: T }>(role, userId, `select ${expression} as result`, params))[0]!.result;

  function checkout(overrides: Record<string, unknown> = {}) {
    sequence += 1;
    return {
      idempotency_key: `remediation-order-${sequence}-0123456789`, fulfillment_type: "pickup",
      first_name: "Audit", last_name: "Customer", phone: "508-555-0142", email: "", sms_opt_in: false, email_opt_in: false,
      special_instructions: "", tip_cents: 0, promo_code: "", items: [{ menu_item_id: itemId, quantity: 1, modifiers: [] }],
      ...overrides,
    };
  }
  const placeOnline = (overrides: Record<string, unknown> = {}) =>
    call<OrderResult>("service_role", null, "public.wayne_create_test_order($1::jsonb)", [JSON.stringify(checkout(overrides))]);
  const status = async (id: string) => (await database.query<{ status: string }>("select status from public.orders where id=$1", [id])).rows[0]!.status;

  beforeAll(async () => {
    await database.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}'::jsonb,last_sign_in_at timestamptz); create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);`);
    await database.exec(`grant usage on schema public to anon, authenticated, service_role;`);
    for (const file of files) await database.exec(readFileSync(resolve(directory, file), "utf8"));
    await database.exec(`
      insert into auth.users(id,email) values ('${ownerId}','owner@remediation.test'),('${managerId}','manager@remediation.test'),('${cashierId}','cashier@remediation.test'),('${kitchenId}','kitchen@remediation.test');
      update public.profiles set active=true, display_name='Owner Olivia', role_id=(select id from public.roles where code='owner') where id='${ownerId}';
      update public.profiles set active=true, display_name='Manager Max', role_id=(select id from public.roles where code='manager') where id='${managerId}';
      update public.profiles set active=true, display_name='Cashier Cam' where id='${cashierId}';
      update public.profiles set active=true, role_id=(select id from public.roles where code='kitchen') where id='${kitchenId}';
      update public.store_settings set ordering_open=true, test_ordering_enabled=true, delivery_enabled=true, delivery_postal_codes=array['01606'], business_hours='${hours}';
      insert into public.menu_categories(id,name) values('${categoryId}','Remediation');
      insert into public.menu_items(id,category_id,name,base_price_cents) values('${itemId}','${categoryId}','Cheese Pizza',1500);
      insert into public.integration_destinations(id,endpoint_url,business_id,signing_secret) values('hanafy','https://crm.test/events','waynes-pizza','remediation-signing-secret-0123456789');
    `);
  }, 90_000);
  afterAll(async () => database.close());

  it("re-applies cleanly over a database that already has it (hosted drift repair)", async () => {
    await database.exec(remediation);
    const functions = await database.query<{ count: number }>("select count(*)::int count from pg_proc where proname in ('wayne_consume_public_order_rate_limit','wayne_transition_order','wayne_admin_dashboard')");
    expect(functions.rows[0]!.count).toBe(3);
    const triggers = await database.query<{ count: number }>("select count(*)::int count from pg_trigger where tgname='menu_items_audit'");
    expect(triggers.rows[0]!.count).toBe(1);
  });

  it("keeps checkout and its rate limiter server-only while the storefront stays public", async () => {
    await expect(call("anon", null, "public.wayne_create_test_order($1::jsonb)", [JSON.stringify(checkout())])).rejects.toThrow(/permission denied/i);
    await expect(call("anon", null, `public.wayne_consume_public_order_rate_limit('${"a".repeat(64)}')`)).rejects.toThrow(/permission denied/i);
    await expect(call("authenticated", cashierId, "public.wayne_create_test_order($1::jsonb)", [JSON.stringify(checkout())])).rejects.toThrow(/permission denied/i);
    const limiter = `public.wayne_consume_public_order_rate_limit('${"b".repeat(64)}')`;
    for (let attempt = 1; attempt <= 8; attempt += 1) expect(await call<boolean>("service_role", null, limiter)).toBe(true);
    expect(await call<boolean>("service_role", null, limiter)).toBe(false);
    await expect(call("service_role", null, "public.wayne_consume_public_order_rate_limit('not-a-hash')")).rejects.toThrow(/Invalid rate limit key/);
    const menu = await call<unknown[]>("anon", null, "public.wayne_public_menu()");
    expect(menu.length).toBe(1);
    const order = await placeOnline();
    expect(order.duplicate).toBe(false);
  });

  it("exposes no SECURITY DEFINER function or table write to anonymous callers beyond the storefront", async () => {
    const definers = await database.query<{ proname: string }>(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute') order by 1`);
    expect(definers.rows.map((row) => row.proname)).toEqual(["wayne_has_permission", "wayne_public_menu", "wayne_public_order_status", "wayne_public_store_settings", "wayne_store_is_open"]);
    const anonWrites = await database.query<{ table_name: string }>(`select table_name from information_schema.role_table_grants where table_schema='public' and grantee='anon' and privilege_type <> 'SELECT'`);
    expect(anonWrites.rows).toEqual([]);
    await expect(run("authenticated", managerId, "select signing_secret from public.integration_destinations")).rejects.toThrow(/permission denied/i);
    await expect(call("authenticated", managerId, "public.wayne_apply_customer_segments(null)")).rejects.toThrow(/permission denied/i);
  });

  it("lets the counter complete orders, emits order.completed, and clears the kitchen board", async () => {
    const order = await placeOnline();
    await database.exec("select 1"); // deferred kitchen trigger has committed with the order
    const board = await call<Array<{ order_id: string }>>("authenticated", kitchenId, "public.wayne_kitchen_board()");
    expect(board.some((ticket) => ticket.order_id === order.id)).toBe(true);
    await expect(call("authenticated", cashierId, `public.wayne_transition_order('${order.id}','ready','completed')`)).rejects.toThrow(/changed on another screen/);
    const result = await call<{ status: string; duplicate: boolean }>("authenticated", cashierId, `public.wayne_transition_order('${order.id}','placed','completed')`);
    expect(result).toEqual({ status: "completed", duplicate: false });
    expect(await call<{ duplicate: boolean }>("authenticated", cashierId, `public.wayne_transition_order('${order.id}','placed','completed')`)).toMatchObject({ duplicate: true });
    const saved = await database.query<{ completed_at: string | null }>("select completed_at from public.orders where id=$1", [order.id]);
    expect(saved.rows[0]!.completed_at).not.toBeNull();
    const events = await database.query<{ event_type: string; actor_user_id: string }>("select event_type, actor_user_id from public.order_events where order_id=$1 order by created_at", [order.id]);
    expect(events.rows.at(-1)).toEqual({ event_type: "order.completed", actor_user_id: cashierId });
    const outbox = await database.query<{ count: number }>("select count(*)::int count from public.integration_outbox where event_type='order.completed' and payload->'data'->>'order_id'=$1", [order.id]);
    expect(outbox.rows[0]!.count).toBe(1);
    const after = await call<Array<{ order_id: string }>>("authenticated", kitchenId, "public.wayne_kitchen_board()");
    expect(after.some((ticket) => ticket.order_id === order.id)).toBe(false);
    const open = await call<Array<{ id: string }>>("authenticated", cashierId, "public.wayne_pos_open_orders()");
    expect(open.some((row) => row.id === order.id)).toBe(false);
  });

  it("routes delivery orders out and back, and rejects invalid hand-offs", async () => {
    const order = await placeOnline({ fulfillment_type: "delivery", address: { address1: "93 West Boylston St", address2: "", city: "Worcester", state: "MA", postal_code: "01606", delivery_instructions: "" } });
    await expect(call("authenticated", cashierId, `public.wayne_transition_order('${order.id}','placed','out_for_delivery')`)).rejects.toThrow(/Only ready delivery orders/);
    for (const [from, to] of [["placed", "accepted"], ["accepted", "in_kitchen"], ["in_kitchen", "ready"]]) {
      await call("authenticated", kitchenId, `public.wayne_kitchen_transition('${order.id}','${from}','${to}')`);
    }
    await call("authenticated", cashierId, `public.wayne_transition_order('${order.id}','ready','out_for_delivery')`);
    await call("authenticated", cashierId, `public.wayne_transition_order('${order.id}','out_for_delivery','completed')`);
    expect(await status(order.id)).toBe("completed");
    await expect(call("authenticated", managerId, `public.wayne_transition_order('${order.id}','completed','cancelled','Too late')`)).rejects.toThrow(/Only open orders/);
  });

  it("requires a manager and a reason to cancel, releases promotion uses, and audits it", async () => {
    await database.exec(`insert into public.promotions(code,discount_type,discount_value,total_usage_limit) values('CANCELME','fixed',200,5);`);
    const order = await placeOnline({ promo_code: "CANCELME", phone: "508-555-0177" });
    await expect(call("authenticated", cashierId, `public.wayne_transition_order('${order.id}','placed','cancelled','Customer called')`)).rejects.toThrow(/cancellation permission/);
    await expect(call("authenticated", managerId, `public.wayne_transition_order('${order.id}','placed','cancelled','')`)).rejects.toThrow(/reason/);
    await call("authenticated", managerId, `public.wayne_transition_order('${order.id}','placed','cancelled','Customer called to cancel')`);
    expect(await status(order.id)).toBe("cancelled");
    const promotion = await database.query<{ uses_count: number }>("select uses_count from public.promotions where code='CANCELME'");
    expect(promotion.rows[0]!.uses_count).toBe(0);
    const audit = await database.query<{ actor_name: string; summary: string }>("select actor_name, summary from public.audit_log where action='order.cancelled' and entity_id=$1", [order.id]);
    expect(audit.rows[0]).toEqual({ actor_name: "Manager Max", summary: `Cancelled order ${order.order_number}: Customer called to cancel` });
    const outbox = await database.query<{ count: number }>("select count(*)::int count from public.integration_outbox where event_type='order.cancelled' and payload->'data'->>'order_id'=$1", [order.id]);
    expect(outbox.rows[0]!.count).toBe(1);
  });

  it("enforces per-customer promotion limits and frees a use when that order is cancelled", async () => {
    await database.exec(`insert into public.promotions(code,discount_type,discount_value,per_customer_limit) values('ONCEEACH','percent',1000,1);`);
    const first = await placeOnline({ promo_code: "ONCEEACH", phone: "508-555-0190" });
    await expect(placeOnline({ promo_code: "ONCEEACH", phone: "508-555-0190" })).rejects.toThrow(/maximum number of times for this customer/);
    expect((await placeOnline({ promo_code: "ONCEEACH", phone: "508-555-0191" })).duplicate).toBe(false);
    await call("authenticated", managerId, `public.wayne_transition_order('${first.id}','placed','cancelled','Duplicate order')`);
    expect((await placeOnline({ promo_code: "ONCEEACH", phone: "508-555-0190" })).duplicate).toBe(false);
    await expect(run("authenticated", cashierId, "insert into public.promotions(code,discount_type,discount_value) values('NOPE','fixed',100)")).rejects.toThrow(/row-level security/);
    await run("authenticated", managerId, "insert into public.promotions(code,discount_type,discount_value) values('MANAGER5','fixed',500)");
  });

  it("queues Hanafy events while delivery is paused and resumes them afterwards", async () => {
    await database.exec("update public.integration_destinations set active=false where id='hanafy'");
    const before = await database.query<{ count: number }>("select count(*)::int count from public.integration_outbox");
    await placeOnline({ phone: "508-555-0199" });
    const after = await database.query<{ count: number }>("select count(*)::int count from public.integration_outbox");
    expect(after.rows[0]!.count).toBeGreaterThan(before.rows[0]!.count);
    expect(await call<unknown>("service_role", null, "public.wayne_claim_hanafy_outbox('test')")).toBeNull();
    const attempts = await database.query<{ count: number }>("select count(*)::int count from public.integration_outbox where attempts > 0");
    expect(attempts.rows[0]!.count).toBe(0);
    await database.exec("update public.integration_destinations set active=true where id='hanafy'");
    expect(await call<{ status: string }>("service_role", null, "public.wayne_claim_hanafy_outbox('test')")).toMatchObject({ status: "processing" });
    await expect(call("authenticated", managerId, "public.wayne_claim_hanafy_outbox('manager')")).rejects.toThrow(/permission denied/i);
  });

  it("starts new accounts inactive and lets only an owner manage staff safely", async () => {
    await database.exec(`insert into auth.users(id,email,raw_user_meta_data) values ('${newcomerId}','new@remediation.test','{"display_name":"New Hire"}')`);
    expect(await call<unknown>("authenticated", newcomerId, "public.wayne_my_access()")).toBeNull();
    const directory = await call<{ staff: Array<{ id: string; email: string; active: boolean; role: string }> }>("authenticated", managerId, "public.wayne_admin_staff()");
    expect(directory.staff.find((member) => member.id === newcomerId)).toMatchObject({ email: "new@remediation.test", active: false, role: "cashier" });
    await expect(call("authenticated", managerId, `public.wayne_admin_update_staff('${newcomerId}','cashier',true)`)).rejects.toThrow(/Staff management permission/);
    await call("authenticated", ownerId, `public.wayne_admin_update_staff('${newcomerId}','kitchen',true,'Kitchen Kim')`);
    expect(await call<{ role: string }>("authenticated", newcomerId, "public.wayne_my_access()")).toMatchObject({ role: "kitchen" });
    await expect(call("authenticated", ownerId, `public.wayne_admin_update_staff('${ownerId}','manager',true)`)).rejects.toThrow(/your own role/);
    await call("authenticated", ownerId, `public.wayne_admin_update_staff('${managerId}','owner',true)`);
    await call("authenticated", managerId, `public.wayne_admin_update_staff('${ownerId}','manager',true)`);
    await expect(call("authenticated", ownerId, `public.wayne_admin_update_staff('${managerId}','manager',true)`)).rejects.toThrow(/Staff management permission/);
    const audit = await database.query<{ actor_name: string; changes: Record<string, unknown> }>("select actor_name, changes from public.audit_log where action='profiles.update' and entity_id=$1 order by id desc limit 1", [newcomerId]);
    expect(audit.rows[0]!.actor_name).toBe("Owner Olivia");
    expect(Object.keys(audit.rows[0]!.changes).sort()).toEqual(["active", "display_name", "role_id"]);
    await call("authenticated", managerId, `public.wayne_record_staff_account_event('${newcomerId}','staff.password_reset')`);
    await database.exec(`update public.profiles set role_id=(select id from public.roles where code='owner') where id='${ownerId}'`);
  });

  it("writes an immutable, redacted audit trail for menu and integration changes", async () => {
    await run("authenticated", ownerId, `update public.menu_items set base_price_cents=1600 where id='${itemId}'`);
    const menuAudit = await database.query<{ actor_name: string; summary: string; changes: Record<string, { from: unknown; to: unknown }> }>("select actor_name, summary, changes from public.audit_log where action='menu_items.update' order by id desc limit 1");
    expect(menuAudit.rows[0]).toEqual({ actor_name: "Owner Olivia", summary: "Updated menu items: Cheese Pizza", changes: { base_price_cents: { from: 1500, to: 1600 } } });
    await call("authenticated", ownerId, "public.wayne_configure_hanafy_integration($1::jsonb)", [JSON.stringify({ endpoint_url: "https://crm.test/events", business_id: "waynes-pizza", signing_secret: "rotated-signing-secret-abcdefghijklmnop", active: true })]);
    const integrationAudit = await database.query<{ changes: string }>("select changes::text changes from public.audit_log where entity_type='integration_destinations' order by id desc limit 1");
    expect(integrationAudit.rows[0]!.changes).toContain("[redacted]");
    expect(integrationAudit.rows[0]!.changes).not.toContain("rotated-signing-secret");
    await expect(database.exec("update public.audit_log set summary='tampered'")).rejects.toThrow(/immutable/);
    await expect(database.exec("delete from public.audit_log")).rejects.toThrow(/immutable/);
    const visible = await run<{ id: number }>("authenticated", managerId, "select id from public.audit_log limit 1");
    expect(visible.length).toBe(1);
    expect(await run("authenticated", cashierId, "select id from public.audit_log")).toEqual([]);
  });

  it("builds the §14 dashboard in the store's business day and reports setup gaps", async () => {
    const localDay = (await database.query<{ day: string }>("select to_char(now() at time zone 'America/New_York','YYYY-MM-DD') as day")).rows[0]!.day;
    const dashboard = await call<{ order_count: number; hourly: unknown[]; customer_mix: Record<string, number>; top_items: Array<{ item_name: string }>; cancelled_count: number; fulfillment_rows: unknown[] }>("authenticated", managerId, `public.wayne_admin_dashboard('${localDay}','${localDay}')`);
    const counted = await database.query<{ count: number }>("select count(*)::int count from public.orders where status <> 'cancelled'");
    expect(dashboard.order_count).toBe(counted.rows[0]!.count);
    expect(dashboard.hourly).toHaveLength(24);
    expect(dashboard.top_items[0]!.item_name).toBe("Cheese Pizza");
    expect(dashboard.cancelled_count).toBe(2);
    expect(dashboard.customer_mix.new_customers + dashboard.customer_mix.returning_customers).toBeGreaterThan(0);
    await expect(call("authenticated", cashierId, `public.wayne_admin_dashboard('${localDay}','${localDay}')`)).rejects.toThrow(/Report viewing permission/);
    const setup = await call<Record<string, unknown>>("authenticated", managerId, "public.wayne_admin_setup_status()");
    expect(setup).toMatchObject({ menu_item_count: 1, tax_rate_basis_points: 0, delivery_postal_code_count: 1, test_ordering_enabled: true, hanafy_active: true });
    const exported = await call<Array<{ business_date: string; placed_at_local: string }>>("authenticated", managerId, `public.wayne_report_orders('${localDay}','${localDay}')`);
    expect(exported[0]!.business_date).toBe(localDay);
    expect(exported[0]!.placed_at_local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
