import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrations = [
  "20260908000000_phase0_foundation.sql", "20260908010000_phase1_public_menu.sql",
  "20260908020000_phase2_orders.sql", "20260908030000_phase3_admin_orders.sql",
  "20260908040000_phase4_front_pos.sql", "20260909050000_phase5_kitchen_printing.sql",
].map((file) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8"));
const ownerId = "49000000-0000-4000-8000-000000000001";
const kitchenId = "49000000-0000-4000-8000-000000000002";
const cashierId = "49000000-0000-4000-8000-000000000003";
const managerId = "49000000-0000-4000-8000-000000000004";
const categoryId = "49000000-0000-4000-8000-000000000010";
const itemId = "49000000-0000-4000-8000-000000000011";
const sideId = "49000000-0000-4000-8000-000000000012";
const variantId = "49000000-0000-4000-8000-000000000013";
const groupId = "49000000-0000-4000-8000-000000000014";
const modifierId = "49000000-0000-4000-8000-000000000015";
const wrongLease = "49000000-0000-4000-8000-000000000099";

type Ticket = {
  order_id: string; status: string; accepted_at: string | null; in_kitchen_at: string | null; ready_at: string | null;
  payload: { source: string; fulfillment_type: string; customer_name: string; instructions: string; items: Array<{
    name: string; variant: string | null; quantity: number; station: string; instructions: string;
    modifiers: Array<{ name: string; group: string; quantity: number }>;
  }> };
};
type PrintJob = { id: string; order_id: string; lease_token: string; status: string; attempts: number; payload: Ticket["payload"] };

describe("Phase 5 committed kitchen tickets and durable printing", () => {
  const database = new PGlite();
  beforeAll(async () => {
    await database.exec(`
      create role anon nologin; create role authenticated nologin; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}'::jsonb);
      create schema storage;
      create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);
    `);
    for (const migration of migrations) await database.exec(migration);
    await database.exec(`
      insert into auth.users(id,email) values ('${ownerId}','owner@phase5.test'),('${kitchenId}','kitchen@phase5.test'),('${cashierId}','cashier@phase5.test'),('${managerId}','manager@phase5.test');
      update public.profiles set role_id=(select id from public.roles where code='owner') where id='${ownerId}';
      update public.profiles set role_id=(select id from public.roles where code='kitchen') where id='${kitchenId}';
      update public.profiles set role_id=(select id from public.roles where code='manager') where id='${managerId}';
      update public.store_settings set ordering_open=true,test_ordering_enabled=true,delivery_postal_codes=array['01606'],
        business_hours='{"sunday":{"closed":false,"open":"00:00","close":"23:59"},"monday":{"closed":false,"open":"00:00","close":"23:59"},"tuesday":{"closed":false,"open":"00:00","close":"23:59"},"wednesday":{"closed":false,"open":"00:00","close":"23:59"},"thursday":{"closed":false,"open":"00:00","close":"23:59"},"friday":{"closed":false,"open":"00:00","close":"23:59"},"saturday":{"closed":false,"open":"00:00","close":"23:59"}}';
      insert into public.menu_categories(id,name) values('${categoryId}','Phase 5 kitchen');
      insert into public.menu_items(id,category_id,name,base_price_cents,kitchen_route) values
        ('${itemId}','${categoryId}','Pizza',1200,'pizza'),('${sideId}','${categoryId}','Fries',500,'fry');
      insert into public.menu_item_variants(id,menu_item_id,name,price_cents) values('${variantId}','${itemId}','Large',1800);
      insert into public.modifier_groups(id,name,customer_label,min_select,max_select,allow_quantities) values('${groupId}','Toppings','Choose toppings',0,3,true);
      insert into public.modifier_choices(id,modifier_group_id,name,price_delta_cents) values('${modifierId}','${groupId}','Pepperoni',150);
      insert into public.menu_item_modifier_groups(menu_item_id,modifier_group_id) values('${itemId}','${groupId}');
    `);
  }, 30_000);
  afterAll(async () => database.close());

  it("publishes complete online and POS tickets, including modifiers, only after order commit", async () => {
    for (const source of ["online", "pos"] as const) {
      const key = `phase5-routing-${source}`;
      await routeItems(database, key);
      const payload = source === "online" ? onlinePayload(key) : posPayload(key);
      await database.exec(`begin; set local role ${source === "online" ? "anon" : "authenticated"}; select set_config('request.jwt.claim.sub','${cashierId}',true);`);
      const inserted = await database.query<{ result: { id: string } }>(
        `select public.${source === "online" ? "wayne_create_test_order" : "wayne_create_pos_order"}($1::jsonb) result`, [JSON.stringify(payload)],
      );
      const id = inserted.rows[0]!.result.id;
      await database.exec("reset role");
      const beforeCommit = await database.query<{ count: number }>("select count(*)::int count from public.kitchen_tickets where order_id=$1", [id]);
      expect(beforeCommit.rows[0]!.count).toBe(0);
      await database.exec("commit");

      const tickets = await call<Ticket[]>(database, kitchenId, "public.wayne_kitchen_board()");
      const ticket = tickets.find((entry) => entry.order_id === id)!;
      expect(ticket.payload).toMatchObject({ source, fulfillment_type: source === "online" ? "delivery" : "pickup", instructions: "Separate the sauces" });
      expect(ticket.payload.items).toHaveLength(2);
      expect(ticket.payload.items.find((item) => item.name === "Pizza")).toEqual({
        id: expect.any(String), name: "Pizza", variant: "Large", quantity: 2, station: `pizza-${key}`, instructions: "Well done",
        modifiers: [{ name: "Pepperoni", group: "Toppings", quantity: 1 }],
      });
      const printJobs = await database.query<{ destination: string; payload: Ticket["payload"] }>("select destination,payload from public.print_jobs where order_id=$1 order by destination", [id]);
      expect(printJobs.rows).toHaveLength(2);
      for (const queued of printJobs.rows) {
        expect(queued.payload.items).toHaveLength(1);
        expect(queued.payload.items[0]!.station).toBe(queued.destination);
      }
      expect(JSON.stringify(ticket)).not.toMatch(/public_access_token|customer_phone|customer_email|delivery_address|payment_status|test@phase5/);
    }
  });

  it("restores the same restricted ticket data on refresh and denies private order access to kitchen staff", async () => {
    const order = await createOnline(database, "phase5-refresh-order");
    const first = await call<Ticket[]>(database, kitchenId, "public.wayne_kitchen_board()");
    const second = await call<Ticket[]>(database, kitchenId, "public.wayne_kitchen_board()");
    expect(second).toEqual(first);
    expect(first.some((ticket) => ticket.order_id === order.id)).toBe(true);
    expect(await asUser(database, kitchenId, "select id,public_access_token from public.orders")).toEqual([]);
    expect(await asUser(database, kitchenId, "select * from public.print_jobs")).toEqual([]);
    expect(await asUser(database, cashierId, "select * from public.kitchen_tickets")).toEqual([]);
    await expect(call(database, cashierId, "public.wayne_kitchen_board()")).rejects.toThrow(/Kitchen access required/);
    await expect(call(database, kitchenId, "public.wayne_admin_orders()")).rejects.toThrow(/permission required/i);
  });

  it("persists Accept, Start, and Ready with timestamps and one audited event per transition", async () => {
    const order = await createOnline(database, "phase5-transition-order");
    for (const [from, to, actor] of [["placed", "accepted", ownerId], ["accepted", "in_kitchen", kitchenId], ["in_kitchen", "ready", kitchenId]]) {
      const result = await transition(database, actor!, order.id, from!, to!);
      expect(result).toEqual({ status: to, duplicate: false });
      expect(await transition(database, actor!, order.id, from!, to!)).toEqual({ status: to, duplicate: true });
      const ticket = (await call<Ticket[]>(database, kitchenId, "public.wayne_kitchen_board()")).find((entry) => entry.order_id === order.id);
      expect(ticket?.status).toBe(to);
    }
    const timestamps = await database.query<{ status: string; accepted_at: Date; in_kitchen_at: Date; ready_at: Date }>("select status,accepted_at,in_kitchen_at,ready_at from public.orders where id=$1", [order.id]);
    expect(timestamps.rows[0]).toMatchObject({ status: "ready", accepted_at: expect.any(Date), in_kitchen_at: expect.any(Date), ready_at: expect.any(Date) });
    const events = await database.query<{ event_type: string; actor_user_id: string }>("select event_type,actor_user_id from public.order_events where order_id=$1 and event_type<>'order.placed' order by created_at,id", [order.id]);
    expect(events.rows).toEqual([
      { event_type: "order.accepted", actor_user_id: ownerId }, { event_type: "order.in_kitchen", actor_user_id: kitchenId }, { event_type: "order.ready", actor_user_id: kitchenId },
    ]);
  });

  it("rejects skipped transitions, stale screens, and unauthorized cashier actions", async () => {
    const order = await createOnline(database, "phase5-conflict-order");
    await expect(transition(database, kitchenId, order.id, "placed", "ready")).rejects.toThrow(/Invalid kitchen transition/);
    await expect(transition(database, cashierId, order.id, "placed", "accepted")).rejects.toThrow(/Kitchen access required/);
    await transition(database, kitchenId, order.id, "placed", "accepted");
    await transition(database, kitchenId, order.id, "accepted", "in_kitchen");
    await expect(transition(database, kitchenId, order.id, "placed", "accepted")).rejects.toThrow(/changed on another screen/);
  });

  it("keeps routed payload snapshots and job counts stable after menu edits and status updates", async () => {
    const order = await createOnline(database, "phase5-snapshot-order");
    const before = await database.query("select destination,payload from public.print_jobs where order_id=$1 order by destination", [order.id]);
    await database.exec(`update public.menu_items set kitchen_route='new-station' where id='${itemId}';`);
    await transition(database, kitchenId, order.id, "placed", "accepted");
    const after = await database.query("select destination,payload from public.print_jobs where order_id=$1 order by destination", [order.id]);
    expect(after.rows).toEqual(before.rows);
    expect((await database.query<{ route: string }>("select kitchen_route_snapshot route from public.order_items where order_id=$1 and menu_item_id=$2", [order.id, itemId])).rows[0]!.route).toBe("pizza-phase5-snapshot-order");
  });

  it("accepts every station route permitted by menu administration", async () => {
    const key = "phase5-long-station-order";
    const longestValidRoute = "s".repeat(120);
    await database.query("update public.menu_items set kitchen_route=$2 where id=$1", [itemId, longestValidRoute]);
    await database.query("update public.menu_items set kitchen_route='fry' where id=$1", [sideId]);
    const order = await createOnline(database, key, false);
    const jobs = await database.query<{ destination: string }>("select destination from public.print_jobs where order_id=$1", [order.id]);
    expect(jobs.rows.map((job) => job.destination)).toContain(longestValidRoute);
  });

  it("retains the order and payload after offline failure and records an owner retry reason", async () => {
    const key = "phase5-offline-order";
    const order = await createOnline(database, key);
    const claimed = await claim(database, key);
    expect(claimed).toMatchObject({ order_id: order.id, status: "processing", attempts: 1 });
    await finish(database, ownerId, claimed!, false, "Printer offline before submission");
    const failed = await database.query<{ status: string; attempts: number; last_error: string; payload: Ticket["payload"] }>("select status,attempts,last_error,payload from public.print_jobs where id=$1", [claimed!.id]);
    expect(failed.rows[0]).toEqual({ status: "failed", attempts: 1, last_error: "Printer offline before submission", payload: claimed!.payload });
    expect((await database.query<{ status: string }>("select status from public.orders where id=$1", [order.id])).rows[0]!.status).toBe("placed");
    await expect(call(database, kitchenId, "public.wayne_retry_print_job($1,'Printer reconnected')", [claimed!.id])).rejects.toThrow(/Print management permission/);
    await call(database, ownerId, "public.wayne_retry_print_job($1,'Printer reconnected and queue checked')", [claimed!.id]);
    const retryEvent = await database.query<{ actor_user_id: string; reason: string }>("select actor_user_id,metadata->>'reason' reason from public.order_events where order_id=$1 and event_type='print.retry_requested'", [order.id]);
    expect(retryEvent.rows).toEqual([{ actor_user_id: ownerId, reason: "Printer reconnected and queue checked" }]);
    const retried = await claim(database, key);
    expect(retried).toMatchObject({ id: claimed!.id, attempts: 2 });
    expect(retried!.lease_token).not.toBe(claimed!.lease_token);
    await finish(database, ownerId, retried!, true);
    await finish(database, ownerId, retried!, true);
    expect((await database.query<{ status: string; printed_at: Date }>("select status,printed_at from public.print_jobs where id=$1", [claimed!.id])).rows[0]).toEqual({ status: "printed", printed_at: expect.any(Date) });
  });

  it("leases each pending station job only once and rejects another token or staff identity", async () => {
    const key = "phase5-lease-order";
    await createOnline(database, key);
    const leased = await claim(database, key);
    expect(await claim(database, key, "second-worker")).toBeNull();
    await expect(finish(database, ownerId, { ...leased!, lease_token: wrongLease }, true)).rejects.toThrow(/Stale print lease/);
    await expect(finish(database, managerId, leased!, true)).rejects.toThrow(/Stale print lease/);
    await expect(call(database, ownerId, "public.wayne_retry_print_job($1,'Premature retry')", [leased!.id])).rejects.toThrow(/Only failed or expired/);
  });

  it("requires inspection of expired leases and rejects late acknowledgements after expiry or retry", async () => {
    const key = "phase5-expired-order";
    await createOnline(database, key);
    const leased = await claim(database, key);
    await database.query("update public.print_jobs set lease_expires_at=now()-interval '1 second' where id=$1", [leased!.id]);
    expect(await claim(database, key, "reconnected-worker")).toBeNull();
    await expect(finish(database, ownerId, leased!, true)).rejects.toThrow(/Expired print lease/);
    await call(database, ownerId, "public.wayne_retry_print_job($1,'Checked device: no ticket printed')", [leased!.id]);
    const next = await claim(database, key);
    expect(next!.lease_token).not.toBe(leased!.lease_token);
    await expect(finish(database, ownerId, leased!, false, "Late stale failure")).rejects.toThrow(/Stale print lease/);
    await finish(database, ownerId, next!, true);
  });

  it("rejects direct ticket and queue mutations and unauthorized print processing", async () => {
    await expect(asUser(database, kitchenId, "update public.kitchen_tickets set status='ready'")).rejects.toThrow(/permission denied/);
    await expect(asUser(database, ownerId, "update public.print_jobs set status='printed'")).rejects.toThrow(/permission denied/);
    await expect(call(database, kitchenId, "public.wayne_claim_print_job('kitchen','unauthorized')")).rejects.toThrow(/Print processing permission/);
    await expect(call(database, cashierId, "public.wayne_claim_print_job('kitchen','unauthorized')")).rejects.toThrow(/Print processing permission/);
  });

  it("does not leave tickets or print jobs for a rolled-back checkout", async () => {
    const key = "phase5-rollback-order";
    await routeItems(database, key);
    await database.exec("begin; set local role anon;");
    const order = await database.query<{ result: { id: string } }>("select public.wayne_create_test_order($1::jsonb) result", [JSON.stringify(onlinePayload(key))]);
    await database.exec("rollback");
    const result = await database.query<{ orders: number; tickets: number; jobs: number }>("select (select count(*)::int from public.orders where id=$1) orders,(select count(*)::int from public.kitchen_tickets where order_id=$1) tickets,(select count(*)::int from public.print_jobs where order_id=$1) jobs", [order.rows[0]!.result.id]);
    expect(result.rows[0]).toEqual({ orders: 0, tickets: 0, jobs: 0 });
  });
});

async function asUser<T>(database: PGlite, userId: string, sql: string, params: unknown[] = []) {
  await database.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${userId}',true);`);
  try { const result = await database.query<T>(sql, params); await database.exec("commit"); return result.rows; }
  catch (error) { await database.exec("rollback"); throw error; }
}
async function call<T>(database: PGlite, userId: string, expression: string, params: unknown[] = []) {
  return (await asUser<{ result: T }>(database, userId, `select ${expression} result`, params))[0]!.result;
}
async function routeItems(database: PGlite, key: string) {
  await database.query("update public.menu_items set kitchen_route=case id when $1::uuid then $3 else $4 end where id in ($1::uuid,$2::uuid)", [itemId, sideId, `pizza-${key}`, `fry-${key}`]);
}
async function createOnline(database: PGlite, key: string, setRoutes = true) {
  if (setRoutes) await routeItems(database, key);
  await database.exec("begin; set local role anon;");
  try {
    const result = await database.query<{ result: { id: string } }>("select public.wayne_create_test_order($1::jsonb) result", [JSON.stringify(onlinePayload(key))]);
    await database.exec("commit"); return result.rows[0]!.result;
  } catch (error) { await database.exec("rollback"); throw error; }
}
function transition(database: PGlite, actor: string, id: string, from: string, to: string) {
  return call(database, actor, "public.wayne_kitchen_transition($1,$2,$3)", [id, from, to]);
}
function claim(database: PGlite, key: string, worker = "kitchen-printer") {
  return call<PrintJob | null>(database, ownerId, "public.wayne_claim_print_job($1,$2)", [`pizza-${key}`, worker]);
}
function finish(database: PGlite, actor: string, job: PrintJob, success: boolean, message: string | null = null) {
  return call(database, actor, "public.wayne_finish_print_job($1,$2,$3,$4)", [job.id, job.lease_token, success, message]);
}
function items() {
  return [
    { menu_item_id: itemId, variant_id: variantId, quantity: 2, special_instructions: "Well done", modifiers: [{ choice_id: modifierId, quantity: 1 }] },
    { menu_item_id: sideId, variant_id: null, quantity: 1, special_instructions: "No salt", modifiers: [] },
  ];
}
function onlinePayload(idempotency_key: string) {
  return {
    idempotency_key, fulfillment_type: "delivery", first_name: "Kitchen", last_name: "Test", phone: "508-555-0155", email: "test@phase5.test",
    sms_opt_in: false, email_opt_in: false, tip_cents: 0, promo_code: "", special_instructions: "Separate the sauces", items: items(),
    address: { address1: "93 West Boylston St", address2: "", city: "Worcester", state: "MA", postal_code: "01606", delivery_instructions: "Private side door" },
  };
}
function posPayload(idempotency_key: string) {
  return {
    ...onlinePayload(idempotency_key), source: "pos", customer_mode: "walk_in", customer_id: "", fulfillment_type: "pickup", payment_method: "test_manual",
    first_name: "", last_name: "", phone: "", email: "", address_id: "", manual_discount_type: "", manual_discount_value: 0, manual_discount_reason: "",
  };
}
