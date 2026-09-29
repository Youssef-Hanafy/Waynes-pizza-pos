import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Phase 7 — Wayne's two Epson printers and the print station, on the full
 * migration chain: online orders queue a receipt-printer slip, every order
 * queues a kitchen ticket, and the print station (a cashier's register) can
 * claim, hand back and finish jobs but not manage them.
 */

const directory = resolve(process.cwd(), "supabase/migrations");
const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const ownerId = "65000000-0000-4000-8000-000000000001";
const cashierId = "65000000-0000-4000-8000-000000000002";
const managerId = "65000000-0000-4000-8000-000000000003";
const categoryId = "65000000-0000-4000-8000-000000000020";
const itemId = "65000000-0000-4000-8000-000000000021";

type Role = "anon" | "authenticated" | "service_role";

describe("Phase 7 — store printers and the print station", () => {
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
  beforeAll(async () => {
    await database.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}'::jsonb,last_sign_in_at timestamptz); create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);`);
    await database.exec("grant usage on schema public to anon, authenticated, service_role;");
    for (const file of files) await database.exec(readFileSync(resolve(directory, file), "utf8"));
    await database.exec(`
      insert into auth.users(id,email,raw_user_meta_data) values
        ('${ownerId}','owner@p7.test','{"display_name":"Owner"}'),
        ('${cashierId}','cashier@p7.test','{"display_name":"Maria"}'),
        ('${managerId}','manager@p7.test','{"display_name":"Joe"}');
      update public.profiles set active=true, role_id=(select id from public.roles where code='owner') where id='${ownerId}';
      update public.profiles set active=true, role_id=(select id from public.roles where code='cashier') where id='${cashierId}';
      update public.profiles set active=true, role_id=(select id from public.roles where code='manager') where id='${managerId}';
      update public.store_settings set test_ordering_enabled=true, pickup_minimum_cents=0;
      insert into public.menu_categories(id,name) values('${categoryId}','Pizza');
      insert into public.menu_items(id,category_id,name,base_price_cents,pos_visible) values('${itemId}','${categoryId}','Cheese Pizza',1500,true);
    `);
  }, 120_000);
  afterAll(async () => database.close());

  type Job = { id: string; order_id: string; destination: string; job_type: string; status: string; lease_token: string | null; last_error: string | null };
  const claim = (destination: string) => call<Job | null>("authenticated", cashierId, "public.wayne_claim_print_job($1, 'station-test')", [destination]);
  let onlineNumber = 0;
  async function onlineOrder(status = "placed", source = "online", fulfillment = "pickup") {
    onlineNumber += 1;
    const rows = await database.query<{ id: string }>(
      `insert into public.orders(order_number, source, fulfillment_type, status, payment_status, payment_method, customer_name_snapshot, customer_phone_snapshot, placed_at, idempotency_key, pricing_snapshot, subtotal_cents, total_cents)
       values ($1, $4, $5, $2, 'paid', 'card', 'Rita', '5085550100', now(), $3, '{}'::jsonb, 1500, 1605) returning id`,
      [`WEB-${onlineNumber}`, status, `online-print-station-key-${onlineNumber}`, source, fulfillment]);
    return rows.rows[0]!.id;
  }
  const receiptJobs = async (orderId: string) =>
    (await database.query<Job>("select * from public.print_jobs where order_id = $1 and destination = 'receipt' order by created_at", [orderId])).rows;

  it("seeds the two Epson printers switched off, with the drawer on the receipt printer", async () => {
    const rows = await database.query<{ receipt: Record<string, unknown>; kitchen: Record<string, unknown>[]; drawer: Record<string, unknown> }>(
      "select receipt_printer receipt, kitchen_printers kitchen, cash_drawer drawer from public.pos_hardware_settings");
    const { receipt, kitchen, drawer } = rows.rows[0]!;
    expect(receipt).toMatchObject({ model_key: "epson-tm-t20iii", protocol: "escpos", port: 9100, enabled: false, paper_width_mm: 80, online_order_slips: true, tip_slip: "always" });
    expect(kitchen[0]).toMatchObject({ model_key: "epson-tm-u220b", protocol: "escpos", port: 9100, enabled: false, paper_width_mm: 76 });
    expect(drawer).toMatchObject({ connection: "receipt_printer" });
  });

  it("queues one receipt-printer slip per online order, once it is placed", async () => {
    const waiting = await onlineOrder("payment_pending");
    expect((await database.query("select 1 from public.print_jobs where order_id = $1", [waiting])).rows).toHaveLength(0);
    await database.query("update public.orders set status = 'placed' where id = $1", [waiting]);
    await database.query("update public.orders set status = 'accepted' where id = $1", [waiting]);
    const jobs = await database.query<Job>("select * from public.print_jobs where order_id = $1", [waiting]);
    expect(jobs.rows).toEqual([expect.objectContaining({ destination: "receipt", job_type: "online_order", status: "pending" })]);
  });

  it("queues a kitchen ticket but no slip for a register order", async () => {
    const order = await call<{ id: string }>("authenticated", cashierId, "public.wayne_create_pos_order($1::jsonb)", [JSON.stringify({
      idempotency_key: "print-station-pos-order-0001", customer_mode: "walk_in", customer_id: "", source: "pos", fulfillment_type: "pickup", payment_method: "test_manual",
      first_name: "", last_name: "", phone: "", email: "", address_id: "", address: { address1: "", address2: "", city: "", state: "", postal_code: "", delivery_instructions: "" },
      promo_code: "", manual_discount_type: "", manual_discount_value: 0, manual_discount_reason: "", tip_cents: 0, special_instructions: "",
      items: [{ menu_item_id: itemId, variant_id: null, quantity: 1, special_instructions: "", modifiers: [] }],
    })]);
    const jobs = await database.query<Job>("select * from public.print_jobs where order_id = $1", [order.id]);
    expect(jobs.rows.map((job) => `${job.destination}/${job.job_type}`)).toEqual(["kitchen/kitchen_ticket"]);
  });

  it("lets the print station claim, hand back while the printer is off, and finish", async () => {
    const visible = await run<Job>("authenticated", cashierId, "select * from public.print_jobs where destination = 'receipt'");
    expect(visible.length).toBeGreaterThan(0);
    const first = (await claim("receipt"))!;
    expect(first).toMatchObject({ destination: "receipt", status: "processing" });
    await expect(call("anon", null, "public.wayne_release_print_job($1::uuid, $2::uuid, 'x')", [first.id, first.lease_token])).rejects.toThrow();
    await expect(call("authenticated", cashierId, "public.wayne_release_print_job($1::uuid, gen_random_uuid(), 'x')", [first.id])).rejects.toThrow(/Stale print lease/);
    await call("authenticated", cashierId, "public.wayne_release_print_job($1::uuid, $2::uuid, $3)", [first.id, first.lease_token, "Printer 192.168.88.20:9100 is not answering."]);
    const released = await database.query<Job>("select * from public.print_jobs where id = $1", [first.id]);
    expect(released.rows[0]).toMatchObject({ status: "pending", lease_token: null, last_error: "Printer 192.168.88.20:9100 is not answering." });
    const again = (await claim("receipt"))!;
    expect(again.id).toBe(first.id);
    await call("authenticated", cashierId, "public.wayne_finish_print_job($1::uuid, $2::uuid, true, null)", [again.id, again.lease_token]);
    expect((await database.query<Job>("select * from public.print_jobs where id = $1", [first.id])).rows[0]).toMatchObject({ status: "printed", last_error: null });
    await expect(call("authenticated", cashierId, "public.wayne_retry_print_job($1::uuid, 'reprint please')", [first.id])).rejects.toThrow(/management permission/);
  });

  it("prints the receipt by itself only for register and phone delivery orders", async () => {
    const delivery = await onlineOrder("placed", "phone", "delivery");
    expect((await receiptJobs(delivery)).map((job) => job.job_type)).toEqual(["delivery_receipt"]);
    const pickup = await onlineOrder("placed", "pos", "pickup");
    expect(await receiptJobs(pickup)).toEqual([]);
  });

  it("queues a receipt when someone asks, once at a time, and again after it printed", async () => {
    const pickup = await onlineOrder("placed", "pos", "pickup");
    expect(await call<{ status: string }>("authenticated", cashierId, "public.wayne_request_receipt_print($1::uuid)", [pickup])).toMatchObject({ status: "queued" });
    expect(await call<{ status: string }>("authenticated", cashierId, "public.wayne_request_receipt_print($1::uuid)", [pickup])).toMatchObject({ status: "already_queued" });
    expect((await receiptJobs(pickup)).map((job) => `${job.job_type}/${job.status}`)).toEqual(["receipt_request/pending"]);
    await database.query("update public.print_jobs set status = 'printed', printed_at = now() where order_id = $1", [pickup]);
    expect(await call<{ status: string }>("authenticated", cashierId, "public.wayne_request_receipt_print($1::uuid)", [pickup])).toMatchObject({ status: "queued" });
    expect((await receiptJobs(pickup)).map((job) => job.status)).toEqual(["pending"]);
    await expect(call("anon", null, "public.wayne_request_receipt_print($1::uuid)", [pickup])).rejects.toThrow();
  });

  it("stops queueing slips when online order printing is switched off", async () => {
    await database.exec("update public.pos_hardware_settings set receipt_printer = receipt_printer || '{\"online_order_slips\": false}'::jsonb");
    const id = await onlineOrder();
    expect((await database.query("select 1 from public.print_jobs where order_id = $1", [id])).rows).toHaveLength(0);
  });
});
