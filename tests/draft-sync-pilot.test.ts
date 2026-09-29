import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phone-line build Phase 6 (tickets shared between registers), Phase 7 prep
 * (print documents) and Phase 9 prep (pilot checklist), on the full chain.
 */

const directory = resolve(process.cwd(), "supabase/migrations");
const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const ownerId = "65000000-0000-4000-8000-000000000001";
const cashierId = "65000000-0000-4000-8000-000000000002";
const managerId = "65000000-0000-4000-8000-000000000003";
const categoryId = "65000000-0000-4000-8000-000000000020";
const itemId = "65000000-0000-4000-8000-000000000021";
const draftId = "65000000-0000-4000-8000-0000000000d1";
const draftKey = "draft-key-0000000000000001";
const registerOne = "register-one-device";
const registerTwo = "register-two-device";

type Role = "anon" | "authenticated" | "service_role";
type Draft = { id: string; device_id: string; terminal: string; status: string; version: number; label: string; payload?: { cart: unknown[] }; order_id: string | null };
type SyncResult = { ok: boolean; reason?: string; draft: Draft | null };
type Check = { key: string; required: boolean; result: string | null; checked_by: string | null };

describe("Phase 6–9 — shared tickets, print documents, pilot checklist", () => {
  const database = new PGlite({ extensions: { pgcrypto } });

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
  const sync = (device: string, extra: Record<string, unknown> = {}) =>
    call<SyncResult>("authenticated", cashierId, "public.wayne_pos_sync_draft($1::jsonb)", [JSON.stringify({
      id: draftId, idempotency_key: draftKey, device_id: device, terminal: device === registerOne ? "Register 1" : "Register 2",
      status: "held", label: "Line 1 · Rita", item_count: 1, phone_line: 1, payload: { cart: [{ menu_item_id: itemId }] }, ...extra,
    })]);

  beforeAll(async () => {
    await database.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}'::jsonb,last_sign_in_at timestamptz); create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);`);
    await database.exec("grant usage on schema public to anon, authenticated, service_role;");
    for (const file of files) await database.exec(readFileSync(resolve(directory, file), "utf8"));
    await database.exec(`
      insert into auth.users(id,email,raw_user_meta_data) values
        ('${ownerId}','owner@p6.test','{"display_name":"Owner"}'),
        ('${cashierId}','cashier@p6.test','{"display_name":"Maria"}'),
        ('${managerId}','manager@p6.test','{"display_name":"Joe"}');
      update public.profiles set active=true, role_id=(select id from public.roles where code='owner') where id='${ownerId}';
      update public.profiles set active=true, role_id=(select id from public.roles where code='cashier') where id='${cashierId}';
      update public.profiles set active=true, role_id=(select id from public.roles where code='manager') where id='${managerId}';
      update public.store_settings set test_ordering_enabled=true, pickup_minimum_cents=0;
      insert into public.menu_categories(id,name) values('${categoryId}','Pizza');
      insert into public.menu_items(id,category_id,name,base_price_cents,pos_visible) values('${itemId}','${categoryId}','Cheese Pizza',1500,true);
    `);
  }, 120_000);
  afterAll(async () => database.close());

  it("mirrors a held ticket so every register can see it", async () => {
    const saved = await sync(registerOne);
    expect(saved.ok).toBe(true);
    expect(saved.draft).toMatchObject({ device_id: registerOne, status: "held", version: 1, label: "Line 1 · Rita" });
    expect((await sync(registerOne, { label: "Line 1 · Rita R" })).draft!.version).toBe(2);
    const open = await call<Draft[]>("authenticated", managerId, "public.wayne_pos_open_drafts()");
    expect(open.map((draft) => draft.id)).toEqual([draftId]);
    expect(open[0]).not.toHaveProperty("payload");
  });

  it("refuses a silent overwrite from another register, and lets it take the ticket over", async () => {
    expect(await sync(registerTwo)).toMatchObject({ ok: false, reason: "taken" });
    const taken = await call<SyncResult>("authenticated", managerId, "public.wayne_pos_take_draft($1::uuid, $2, $3)", [draftId, registerTwo, "Register 2"]);
    expect(taken.ok).toBe(true);
    expect(taken.draft).toMatchObject({ device_id: registerTwo, terminal: "Register 2", status: "open" });
    expect(taken.draft!.payload!.cart).toHaveLength(1);
    // Register 1 comes back online with its old copy: it is told, not obeyed.
    expect(await sync(registerOne)).toMatchObject({ ok: false, reason: "taken" });
    const audit = await database.query<{ count: number }>("select count(*)::int count from public.audit_log where action = 'pos.ticket_taken_over'");
    expect(audit.rows[0]!.count).toBe(1);
  });

  it("closes the ticket when its order exists, and never resurrects a sent ticket", async () => {
    await expect(call("authenticated", cashierId, "public.wayne_pos_close_draft($1::uuid, $2, 'submitted')", [draftId, registerTwo])).rejects.toThrow(/not been sent/);
    const order = await call<{ id: string }>("authenticated", cashierId, "public.wayne_create_pos_order($1::jsonb)", [JSON.stringify({
      idempotency_key: draftKey, customer_mode: "walk_in", customer_id: "", source: "pos", fulfillment_type: "pickup", payment_method: "test_manual",
      first_name: "", last_name: "", phone: "", email: "", address_id: "", address: { address1: "", address2: "", city: "", state: "", postal_code: "", delivery_instructions: "" },
      promo_code: "", manual_discount_type: "", manual_discount_value: 0, manual_discount_reason: "", tip_cents: 0, special_instructions: "Well done",
      items: [{ menu_item_id: itemId, variant_id: null, quantity: 2, special_instructions: "Extra crispy", modifiers: [] }],
    })]);
    // Even if nobody closed it, the open list notices the order and closes it.
    expect(await call<Draft[]>("authenticated", cashierId, "public.wayne_pos_open_drafts()")).toEqual([]);
    const closed = await database.query<{ status: string; order_id: string }>("select status, order_id from public.pos_drafts where id = $1", [draftId]);
    expect(closed.rows[0]).toEqual({ status: "submitted", order_id: order.id });
    expect(await sync(registerTwo)).toMatchObject({ ok: false, reason: "closed" });
    const fresh = await call<SyncResult>("authenticated", cashierId, "public.wayne_pos_sync_draft($1::jsonb)", [JSON.stringify({
      id: "65000000-0000-4000-8000-0000000000d2", idempotency_key: draftKey, device_id: registerOne, status: "open", payload: {},
    })]);
    expect(fresh).toMatchObject({ ok: false, reason: "closed" });
  });

  it("only lets the holding register discard a ticket", async () => {
    const id = "65000000-0000-4000-8000-0000000000d3";
    await call("authenticated", cashierId, "public.wayne_pos_sync_draft($1::jsonb)", [JSON.stringify({ id, idempotency_key: "draft-key-0000000000000003", device_id: registerOne, status: "open", payload: { cart: [] } })]);
    expect(await call<SyncResult>("authenticated", cashierId, "public.wayne_pos_close_draft($1::uuid, $2, 'discarded')", [id, registerTwo])).toMatchObject({ ok: false, reason: "taken" });
    expect(await call<SyncResult>("authenticated", cashierId, "public.wayne_pos_close_draft($1::uuid, $2, 'discarded')", [id, registerOne])).toMatchObject({ ok: true });
  });

  it("keeps tickets away from the anon key", async () => {
    await expect(run("anon", null, "select * from public.pos_drafts")).rejects.toThrow();
    await expect(run("anon", null, "select public.wayne_pos_open_drafts()")).rejects.toThrow();
  });

  it("builds a protocol-free print document with category and modifiers", async () => {
    const orderId = (await database.query<{ id: string }>("select id from public.orders where idempotency_key = $1", [draftKey])).rows[0]!.id;
    const doc = await call<{ order: { order_number: string; total_cents: number; taken_by: string }; items: { name: string; category: string; quantity: number; instructions: string }[]; store: { name: string } }>(
      "authenticated", cashierId, "public.wayne_pos_print_document($1::uuid)", [orderId]);
    expect(doc.order.taken_by).toBe("Maria");
    expect(doc.items).toEqual([expect.objectContaining({ name: "Cheese Pizza", category: "Pizza", quantity: 2, instructions: "Extra crispy" })]);
    expect(doc.order.total_cents).toBeGreaterThan(0);
    await expect(run("anon", null, "select public.wayne_pos_print_document($1::uuid)", [orderId])).rejects.toThrow();
  });

  it("records pilot results for owner and manager only, and never lets a required check be skipped", async () => {
    const list = await call<Check[]>("authenticated", ownerId, "public.wayne_pilot_checklist()");
    expect(list.length).toBeGreaterThanOrEqual(25);
    await expect(call("authenticated", cashierId, "public.wayne_record_pilot_check('call_line1', 'pass', '')")).rejects.toThrow(/owner or a manager/);
    const after = await call<Check[]>("authenticated", managerId, "public.wayne_record_pilot_check('call_line1', 'pass', 'Called from my cell')");
    expect(after.find((check) => check.key === "call_line1")).toMatchObject({ result: "pass", checked_by: "Joe" });
    await expect(call("authenticated", ownerId, "public.wayne_record_pilot_check('call_line2', 'not_applicable', '')")).rejects.toThrow(/cannot be marked not applicable/);
    const optional = await call<Check[]>("authenticated", ownerId, "public.wayne_record_pilot_check('order_second_register', 'not_applicable', 'One register for now')");
    expect(optional.find((check) => check.key === "order_second_register")!.result).toBe("not_applicable");
  });
});
