import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phone-line build (Phases 2–5): the caller-event lifecycle, claims between
 * registers, customer matching, and the order carrying its call — run against
 * the full migration chain.
 */

const directory = resolve(process.cwd(), "supabase/migrations");
const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const ownerId = "62000000-0000-4000-8000-000000000001";
const cashierId = "62000000-0000-4000-8000-000000000002";
const secondCashierId = "62000000-0000-4000-8000-000000000003";
const ritaId = "62000000-0000-4000-8000-000000000010";
const householdId = "62000000-0000-4000-8000-000000000011";
const erasedId = "62000000-0000-4000-8000-000000000012";
const categoryId = "62000000-0000-4000-8000-000000000020";
const itemId = "62000000-0000-4000-8000-000000000021";

type Role = "anon" | "authenticated" | "service_role";
type Match = { id: string; first_name: string; phones: { phone: string }[] };
type Call = { id: string; event_key: string; line_number: number; status: string; caller_number: string | null; customer_id: string | null; claimed_by_name: string | null; claimed_terminal: string; order_id: string | null; order_number: string | null; matches: Match[] };
type Board = { expire_minutes: number; lines: { line_number: number; call: Call | null }[]; recent: { id: string; status: string; order_number: string | null }[] };
type Recorded = { ok: boolean; duplicate: boolean; call_id: string; call?: Call };
type Action = { ok: boolean; reason?: string; call: Call };

describe("Phone-line build — caller events, claims and phone orders", () => {
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

  const simulate = (userId: string, payload: Record<string, unknown>) =>
    call<Recorded>("authenticated", userId, "public.wayne_pos_record_call($1::jsonb)", [JSON.stringify({ source: "simulated", ...payload })]);
  const bridge = (payload: Record<string, unknown>) =>
    call<Recorded>("service_role", null, "public.wayne_record_phone_call($1::jsonb)", [JSON.stringify(payload)]);
  const board = (userId = cashierId) => call<Board>("authenticated", userId, "public.wayne_phone_board()");
  const act = (userId: string, callId: string, action: string, terminal = "", force = false) =>
    call<Action>("authenticated", userId, "public.wayne_phone_call_action($1::uuid, $2, $3, $4)", [callId, action, terminal, force]);
  const order = (userId: string, payload: Record<string, unknown>) =>
    call<{ id: string; order_number: string }>("authenticated", userId, "public.wayne_create_pos_order($1::jsonb)", [JSON.stringify(payload)]);

  const orderPayload = (key: string, extra: Record<string, unknown>) => ({
    idempotency_key: key, customer_mode: "identified", customer_id: "", source: "phone", fulfillment_type: "pickup",
    payment_method: "test_manual", first_name: "Regular", last_name: "Rita", phone: "5085550111", email: "", address_id: "",
    address: { address1: "", address2: "", city: "", state: "", postal_code: "", delivery_instructions: "" },
    promo_code: "", manual_discount_type: "", manual_discount_value: 0, manual_discount_reason: "", tip_cents: 0, special_instructions: "",
    items: [{ menu_item_id: itemId, variant_id: null, quantity: 1, special_instructions: "", modifiers: [] }],
    ...extra,
  });

  beforeAll(async () => {
    await database.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}'::jsonb,last_sign_in_at timestamptz); create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);`);
    await database.exec("grant usage on schema public to anon, authenticated, service_role;");
    for (const file of files) await database.exec(readFileSync(resolve(directory, file), "utf8"));
    await database.exec(`
      insert into auth.users(id,email,raw_user_meta_data) values
        ('${ownerId}','owner@phone.test','{"display_name":"Owner"}'),
        ('${cashierId}','cashier@phone.test','{"display_name":"Maria"}'),
        ('${secondCashierId}','cashier2@phone.test','{"display_name":"Joe"}');
      update public.profiles set active=true, role_id=(select id from public.roles where code='owner') where id='${ownerId}';
      update public.profiles set active=true, role_id=(select id from public.roles where code='cashier') where id in ('${cashierId}','${secondCashierId}');
      update public.store_settings set test_ordering_enabled=true, pickup_minimum_cents=0, delivery_minimum_cents=0;
      insert into public.customers(id,first_name,last_name,phone_normalized,last_order_at) values
        ('${ritaId}','Regular','Rita','+15085550111', now() - interval '2 days'),
        ('${householdId}','Harold','House','+15085550999', null),
        ('${erasedId}','Gone','Away','+15085550777', null);
      update public.customers set removed_at = now() where id = '${erasedId}';
      insert into public.menu_categories(id,name) values('${categoryId}','Phone test');
      insert into public.menu_items(id,category_id,name,base_price_cents,pos_visible) values('${itemId}','${categoryId}','Cheese Pizza',1500,true);
    `);
  }, 120_000);
  afterAll(async () => database.close());

  it("shows a simulated Line 1 call with the matched customer, and keeps Line 2 separate", async () => {
    const first = await simulate(cashierId, { event_key: "sim-1", line_number: 1, caller_number: "(508) 555-0111", caller_name: "RITA" });
    expect(first.duplicate).toBe(false);
    expect(first.call!.matches.map((match) => match.first_name)).toEqual(["Regular"]);
    expect(first.call!.customer_id).toBe(ritaId);

    await simulate(cashierId, { event_key: "sim-2", line_number: 2, caller_number: "7745552222", caller_name: "JANE" });
    const view = await board();
    expect(view.lines.map((line) => line.line_number)).toEqual([1, 2]);
    expect(view.lines[0]!.call!.caller_number).toBe("+15085550111");
    expect(view.lines[1]!.call!.caller_number).toBe("+17745552222");
    // An unknown caller is never turned into a customer by caller ID alone.
    expect(view.lines[1]!.call!.matches).toEqual([]);
    const created = await database.query<{ count: number }>("select count(*)::int count from public.customers where phone_normalized = '+17745552222'");
    expect(created.rows[0]!.count).toBe(0);
  });

  it("drops repeated packets but never a second, separate call", async () => {
    expect((await simulate(cashierId, { event_key: "sim-1", line_number: 1, caller_number: "5085550111" })).duplicate).toBe(true);
    const a = await bridge({ line_number: 1, caller_number: "5085550333", device_id: "unit-1" });
    const b = await bridge({ line_number: 1, caller_number: "5085550333", device_id: "unit-1" });
    expect(b.duplicate).toBe(true);
    expect(b.call_id).toBe(a.call_id);
    await bridge({ line_number: 1, caller_number: "5085550333", device_id: "unit-1", event: "end" });
    const again = await bridge({ line_number: 1, caller_number: "5085550333", device_id: "unit-1" });
    expect(again.duplicate).toBe(false);
    expect(again.call_id).not.toBe(a.call_id);
  });

  it("offers a choice when a number belongs to more than one customer", async () => {
    await call("authenticated", cashierId, "public.wayne_pos_save_customer($1::jsonb)", [JSON.stringify({
      customer_id: householdId, first_name: "Harold", last_name: "House", phone: "5085550999", extra_phone: "5085550444", extra_phone_label: "home",
    })]);
    await database.exec("insert into public.customer_phones(customer_id, phone_normalized) values ('" + ritaId + "', '+15085550444')");
    const recorded = await simulate(cashierId, { event_key: "sim-shared", line_number: 2, caller_number: "508-555-0444" });
    expect(recorded.call!.matches).toHaveLength(2);
    // Ambiguous, so nobody is attached automatically.
    expect(recorded.call!.customer_id).toBeNull();
  });

  it("locks a call to the register that claimed it", async () => {
    const line1 = (await board()).lines[0]!.call!;
    const mine = await act(cashierId, line1.id, "claim", "Register 1");
    expect(mine.ok).toBe(true);
    expect(mine.call.status).toBe("selected");
    expect(mine.call.claimed_by_name).toBe("Maria");

    const theirs = await act(secondCashierId, line1.id, "claim", "Register 2");
    expect(theirs).toMatchObject({ ok: false, reason: "claimed" });
    expect(theirs.call.claimed_terminal).toBe("Register 1");

    const forced = await act(secondCashierId, line1.id, "claim", "Register 2", true);
    expect(forced.ok).toBe(true);
    expect(forced.call.claimed_terminal).toBe("Register 2");
    expect((await act(secondCashierId, line1.id, "release")).call.status).toBe("incoming");
  });

  it("dismisses into recent calls and can reopen", async () => {
    const line2 = (await board()).lines[1]!.call!;
    await act(cashierId, line2.id, "dismiss");
    let view = await board();
    expect(view.lines[1]!.call).toBeNull();
    expect(view.recent.find((entry) => entry.id === line2.id)!.status).toBe("dismissed");
    await act(cashierId, line2.id, "reopen");
    view = await board();
    expect(view.lines[1]!.call!.id).toBe(line2.id);
  });

  it("links the order to the call and the line, and clears the line", async () => {
    const line1 = (await board()).lines[0]!.call!;
    // The newest ring on Line 1 is the bridge call; use the simulated Rita call.
    const ritaCall = (await database.query<{ id: string }>("select id from public.phone_calls where event_key = 'sim-1'")).rows[0]!.id;
    expect(line1).toBeTruthy();
    expect((await act(cashierId, ritaCall, "start_order", "Register 1")).call.status).toBe("order_started");
    const created = await order(cashierId, orderPayload("phone-order-0000001", { customer_id: ritaId, phone_call_id: ritaCall, phone_line: 1 }));
    const saved = await database.query<{ phone_line: number; phone_call_id: string; source: string }>("select phone_line, phone_call_id, source from public.orders where id = $1", [created.id]);
    expect(saved.rows[0]).toEqual({ phone_line: 1, phone_call_id: ritaCall, source: "phone" });
    const linked = await database.query<{ status: string; order_id: string }>("select status, order_id from public.phone_calls where id = $1", [ritaCall]);
    expect(linked.rows[0]).toEqual({ status: "completed", order_id: created.id });
    const recent = (await board()).recent.find((entry) => entry.id === ritaCall)!;
    expect(recent.order_number).toBe(created.order_number);
  });

  it("takes a phone order without a profile for pickup only", async () => {
    const pickup = await order(cashierId, orderPayload("phone-order-0000002", { customer_mode: "walk_in", first_name: "Jane", last_name: "", phone: "7745552222" }));
    const saved = await database.query<{ customer_id: string | null; customer_name_snapshot: string; customer_phone_snapshot: string }>("select customer_id, customer_name_snapshot, customer_phone_snapshot from public.orders where id = $1", [pickup.id]);
    expect(saved.rows[0]).toEqual({ customer_id: null, customer_name_snapshot: "Jane", customer_phone_snapshot: "+17745552222" });
    await expect(order(cashierId, orderPayload("phone-order-0000003", { customer_mode: "walk_in", fulfillment_type: "delivery" }))).rejects.toThrow(/pickup/);
  });

  it("keeps the call log away from the anon key and the phone board away from non-POS roles", async () => {
    await expect(run("anon", null, "select * from public.phone_calls")).rejects.toThrow();
    const visible = await run<{ id: string }>("authenticated", cashierId, "select id from public.phone_calls");
    expect(visible.length).toBeGreaterThan(0);
    await expect(run("anon", null, "select public.wayne_phone_board()")).rejects.toThrow();
  });

  it("lets only the owner change hardware settings, and lines follow the configured count", async () => {
    await expect(call("authenticated", cashierId, "public.wayne_update_hardware_settings($1::jsonb)", [JSON.stringify({ caller_line_count: 3 })])).rejects.toThrow(/owner/);
    const settings = await call<{ caller_line_count: number; caller_udp_port: number }>("authenticated", ownerId, "public.wayne_update_hardware_settings($1::jsonb)", [JSON.stringify({ caller_line_count: 3 })]);
    expect(settings).toMatchObject({ caller_line_count: 3, caller_udp_port: 3520 });
    expect((await board()).lines.map((line) => line.line_number)).toEqual([1, 2, 3]);
    await call("authenticated", ownerId, "public.wayne_update_hardware_settings($1::jsonb)", [JSON.stringify({ caller_line_count: 2, simulator_enabled: false })]);
    expect((await board()).lines).toHaveLength(2);
    await expect(simulate(cashierId, { line_number: 1, caller_number: "5085550000" })).rejects.toThrow(/simulator/);
    const audit = await database.query<{ count: number }>("select count(*)::int count from public.audit_log where action = 'hardware.settings_updated'");
    expect(audit.rows[0]!.count).toBe(2);
  });

  it("searches extra numbers, hides erased customers, and refuses a duplicate primary number", async () => {
    const byExtra = await call<Match[]>("authenticated", cashierId, "public.wayne_pos_customer_search($1)", ["508-555-0444"]);
    expect(byExtra.map((match) => match.first_name).sort()).toEqual(["Harold", "Regular"]);
    expect(await call<Match[]>("authenticated", cashierId, "public.wayne_pos_customer_search($1)", ["Gone Away"])).toEqual([]);
    await expect(call("authenticated", cashierId, "public.wayne_pos_save_customer($1::jsonb)", [JSON.stringify({ first_name: "Copy", last_name: "Cat", phone: "5085550111" })])).rejects.toThrow(/already exists/);
    const created = await call<Match>("authenticated", cashierId, "public.wayne_pos_save_customer($1::jsonb)", [JSON.stringify({ first_name: "New", last_name: "Caller", phone: "7745552222" })]);
    expect(created.first_name).toBe("New");
    const history = await call<{ order_number: string }[]>("authenticated", cashierId, "public.wayne_pos_customer_orders($1::uuid)", [ritaId]);
    expect(history).toHaveLength(1);
  });
});
