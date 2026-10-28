import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Tips saved as they are typed (owner, 2026-10-28), on the full migration chain:
 * the newest value wins, a stale copy never overwrites it, only orders still
 * waiting for their tip are read back, nothing is ever charged, and app roles
 * can't touch the table directly.
 */
const directory = resolve(process.cwd(), "supabase/migrations");
const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const ownerId = "66000000-0000-4000-8000-000000000001";
const cashierId = "66000000-0000-4000-8000-000000000002";
const heldOrder = "66000000-0000-4000-8000-0000000000a1";
const paidOrder = "66000000-0000-4000-8000-0000000000a2";

type Role = "anon" | "authenticated" | "service_role";
type Row = { order_id: string; tip_cents: number; raw: string; screen: string; client_updated_at: string; applied?: boolean };

describe("tip drafts (pos_tip_drafts)", () => {
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
  const save = (userId: string, drafts: Record<string, unknown>[]) =>
    call<Row[]>("authenticated", userId, "public.wayne_pos_save_tip_drafts($1::jsonb)", [JSON.stringify(drafts)]);

  beforeAll(async () => {
    await database.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}'::jsonb,last_sign_in_at timestamptz); create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);`);
    await database.exec("grant usage on schema public to anon, authenticated, service_role;");
    for (const file of files) await database.exec(readFileSync(resolve(directory, file), "utf8"));
    await database.exec(`
      insert into auth.users(id,email,raw_user_meta_data) values
        ('${ownerId}','owner@tips.test','{"display_name":"Owner"}'),
        ('${cashierId}','cashier@tips.test','{"display_name":"Maria"}');
      update public.profiles set active=true, role_id=(select id from public.roles where code='owner') where id='${ownerId}';
      update public.profiles set active=true, role_id=(select id from public.roles where code='cashier') where id='${cashierId}';
      insert into public.orders(id, order_number, source, fulfillment_type, status, payment_status, payment_method, customer_name_snapshot, customer_phone_snapshot, placed_at, idempotency_key, pricing_snapshot, subtotal_cents, total_cents) values
        ('${heldOrder}', 'TIP-1', 'pos', 'pickup', 'completed', 'authorized', 'card', 'Rita', '5085550100', now(), 'tip-drafts-key-000000001', '{}'::jsonb, 1900, 2000),
        ('${paidOrder}', 'TIP-2', 'pos', 'pickup', 'completed', 'paid', 'card', 'Sam', '5085550101', now(), 'tip-drafts-key-000000002', '{}'::jsonb, 1900, 2000);
      insert into public.payments(order_id,provider,provider_payment_id,method,amount_cents,status) values
        ('${heldOrder}','test','tips-held','card',2000,'authorized'),
        ('${paidOrder}','test','tips-paid','card',2000,'captured');
    `);
  }, 180_000);
  afterAll(async () => database.close());

  it("saves a typed tip and reads it back while the card is still held", async () => {
    const [row] = await save(cashierId, [{ order_id: heldOrder, tip_cents: 500, raw: "5", screen: "tips", client_updated_at: "2026-10-28T01:00:00Z", device_id: "register-one", terminal: "Register 1" }]);
    expect(row).toMatchObject({ order_id: heldOrder, tip_cents: 500, applied: true });
    const listed = await call<Row[]>("authenticated", ownerId, "public.wayne_pos_tip_drafts()");
    expect(listed.map((entry) => entry.tip_cents)).toEqual([500]);
  });

  it("an older copy (offline register) never overwrites the newer value", async () => {
    const [stale] = await save(cashierId, [{ order_id: heldOrder, tip_cents: 300, raw: "3", screen: "tips", client_updated_at: "2026-10-28T00:30:00Z" }]);
    expect(stale).toMatchObject({ tip_cents: 500, applied: false });
    const [newer] = await save(ownerId, [{ order_id: heldOrder, tip_cents: 650, raw: "6.50", screen: "delivery", client_updated_at: "2026-10-28T01:10:00Z" }]);
    expect(newer).toMatchObject({ tip_cents: 650, applied: true, screen: "delivery" });
  });

  it("an order no longer waiting for a tip (card captured) is not read back", async () => {
    await save(cashierId, [{ order_id: paidOrder, tip_cents: 100, raw: "1", screen: "tips", client_updated_at: "2026-10-28T01:00:00Z" }]);
    const listed = await call<Row[]>("authenticated", ownerId, "public.wayne_pos_tip_drafts()");
    expect(listed.map((entry) => entry.order_id)).toEqual([heldOrder]);
  });

  it("saving never charges or changes the order or its payment", async () => {
    const [payment] = await database.query<{ status: string; amount_cents: number }>(`select status, amount_cents from public.payments where order_id='${heldOrder}'`).then((result) => result.rows);
    expect(payment).toMatchObject({ status: "authorized", amount_cents: 2000 });
    const [order] = await database.query<{ tip_cents: number }>(`select tip_cents from public.orders where id='${heldOrder}'`).then((result) => result.rows);
    expect(order!.tip_cents).toBe(0);
  });

  it("refuses bad amounts and strangers; app roles can't read the table", async () => {
    await expect(save(cashierId, [{ order_id: heldOrder, tip_cents: -5, client_updated_at: "2026-10-28T02:00:00Z" }])).rejects.toThrow("between");
    await expect(call("anon", null, "public.wayne_pos_tip_drafts()")).rejects.toThrow();
    await expect(run("authenticated", ownerId, "select * from public.pos_tip_drafts")).rejects.toThrow("permission denied");
  });

  it("clears the entries after Charge / Cash out", async () => {
    expect(await call<number>("authenticated", ownerId, `public.wayne_pos_clear_tip_drafts(array['${heldOrder}','${paidOrder}']::uuid[])`)).toBe(2);
    expect(await call<Row[]>("authenticated", ownerId, "public.wayne_pos_tip_drafts()")).toEqual([]);
  });
});
