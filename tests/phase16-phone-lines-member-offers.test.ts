import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWhozzCallingRecord } from "@/lib/phone/schemas";

const directory = resolve(process.cwd(), "supabase/migrations");
const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const ownerId = "61000000-0000-4000-8000-000000000001";
const cashierId = "61000000-0000-4000-8000-000000000002";
const memberId = "61000000-0000-4000-8000-000000000010";
const strangerId = "61000000-0000-4000-8000-000000000011";
const categoryId = "61000000-0000-4000-8000-000000000020";
const itemId = "61000000-0000-4000-8000-000000000021";

type Role = "anon" | "authenticated" | "service_role";
type Board = { line_number: number; label: string; call: null | { caller_number: string | null; customer: null | { first_name: string } } }[];
type MemberOffers = { member: boolean; first_name?: string; offers: { code: string; personal: boolean }[] };

describe("Phase 16 — caller ID lines and Wayne's Rewards offers", () => {
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

  const ring = (payload: Record<string, unknown>) =>
    call<{ ok: boolean; matched?: boolean }>("service_role", null, "public.wayne_record_phone_call($1::jsonb)", [JSON.stringify(payload)]);

  beforeAll(async () => {
    await database.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}'::jsonb,last_sign_in_at timestamptz); create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);`);
    await database.exec("grant usage on schema public to anon, authenticated, service_role;");
    for (const file of files) await database.exec(readFileSync(resolve(directory, file), "utf8"));
    await database.exec(`
      insert into auth.users(id,email) values ('${ownerId}','owner@phase16.test'),('${cashierId}','cashier@phase16.test');
      update public.profiles set active=true, role_id=(select id from public.roles where code='owner') where id='${ownerId}';
      update public.profiles set active=true, role_id=(select id from public.roles where code='cashier') where id='${cashierId}';
      insert into public.customers(id,first_name,last_name,phone_normalized,sms_marketing_opt_in)
        values('${memberId}','Regular','Rita','+15085550111',true),
              ('${strangerId}','Passing','Pat','+15085550222',false);
      insert into public.menu_categories(id,name) values('${categoryId}','Phase 16');
      insert into public.menu_items(id,category_id,name,base_price_cents) values('${itemId}','${categoryId}','Cheese Pizza',1500);
      insert into public.promotions(code,description,discount_type,discount_value,minimum_order_cents,members_only)
        values('REWARDS5','Members save five dollars','fixed',500,0,true);
      insert into public.promotions(code,description,discount_type,discount_value,minimum_order_cents)
        values('EVERYONE3','Three dollars off for anybody','fixed',300,0);
    `);
  }, 90_000);
  afterAll(async () => database.close());

  it("reads the record the store's caller ID box actually sends", () => {
    const parsed = parseWhozzCallingRecord("^^<U>000001<S>001234$02 I S 0000 G A2 12/17 04:54 PM 508-555-0111 RITA REGULAR___");
    expect(parsed).toMatchObject({ line_number: 2, direction: "inbound", event: "start", caller_number: "5085550111", caller_name: "RITA REGULAR", unit_number: "1" });
    // The end-of-call record closes the ring rather than opening another.
    expect(parseWhozzCallingRecord("$01 I E 0042 G A2 12/17 04:56 PM 5085550222 UNKNOWN")?.event).toBe("end");
    expect(parseWhozzCallingRecord("garbage from the wire")).toBeNull();
  });

  it("ships with Wayne's two lines and matches a known caller as the call is recorded", async () => {
    const result = await ring({ line_number: 1, caller_number: "508-555-0111", caller_name: "RITA REGULAR" });
    expect(result.matched).toBe(true);
    const board = await call<Board>("authenticated", cashierId, "public.wayne_phone_line_board()");
    expect(board.map((line) => line.line_number)).toEqual([1, 2]);
    expect(board[0]!.call!.caller_number).toBe("+15085550111");
    expect(board[0]!.call!.customer!.first_name).toBe("Regular");
    // Line 2 is quiet, and still shows, because the cashier needs to see both.
    expect(board[1]!.call).toBeNull();
  });

  it("records a first-time caller without a customer, and closes the call on hang-up", async () => {
    expect((await ring({ line_number: 2, caller_number: "5085559999" })).matched).toBe(false);
    await ring({ line_number: 2, event: "end" });
    const board = await call<Board>("authenticated", cashierId, "public.wayne_phone_line_board()");
    expect(board[1]!.call!.customer).toBeNull();
    const ended = await database.query<{ ended_at: string | null }>("select ended_at from public.phone_calls where line_number=2 order by started_at desc limit 1");
    expect(ended.rows[0]!.ended_at).not.toBeNull();
  });

  it("keeps the call log off the public internet and out of a signed-out browser", async () => {
    await expect(call("anon", null, "public.wayne_phone_line_board()")).rejects.toThrow(/permission denied/i);
    await expect(run("anon", null, "select * from public.phone_calls")).rejects.toThrow(/permission denied/i);
    await expect(call("authenticated", null, "public.wayne_record_phone_call('{}'::jsonb)")).rejects.toThrow(/permission denied/i);
  });

  it("never lists a member-only or personal code among the public deals", async () => {
    const promotions = await call<{ code: string }[]>("anon", null, "public.wayne_public_promotions()");
    const codes = promotions.map((promotion) => promotion.code);
    expect(codes).toContain("EVERYONE3");
    expect(codes).not.toContain("REWARDS5");
  });

  it("shows a member their offers and shows a non-member the door to join", async () => {
    const member = await call<MemberOffers>("service_role", null, "public.wayne_member_offers('(508) 555-0111')");
    expect(member.member).toBe(true);
    expect(member.first_name).toBe("Regular");
    expect(member.offers.map((offer) => offer.code)).toContain("REWARDS5");

    const stranger = await call<MemberOffers>("service_role", null, "public.wayne_member_offers('5085550222')");
    expect(stranger).toMatchObject({ member: false, reason: "not_a_member", offers: [] });

    const nobody = await call<MemberOffers>("service_role", null, "public.wayne_member_offers('5085550000')");
    expect(nobody.member).toBe(false);

    // The lookup is server-only: it hands out codes, so the anon key never gets it.
    await expect(call("anon", null, "public.wayne_member_offers('5085550111')")).rejects.toThrow(/permission denied/i);
  });

  it("refuses a members-only code on an order that has no Wayne's Rewards customer", async () => {
    const orders = await database.query<{ id: string }>(
      `insert into public.orders(order_number,customer_id,source,fulfillment_type,status,payment_status,payment_method,customer_name_snapshot,customer_phone_snapshot,pricing_snapshot,idempotency_key,subtotal_cents,total_cents)
         values('W-16-1','${strangerId}','online','pickup','placed','unpaid','cash','Passing Pat','+15085550222','{}'::jsonb,'phase16-stranger-0123456789',1500,1500) returning id`,
    );
    const orderId = orders.rows[0]!.id;
    await expect(
      database.query(
        `insert into public.order_discounts(order_id,promotion_id,code_snapshot,description_snapshot,discount_type_snapshot,discount_value_snapshot,amount_cents)
           select '${orderId}', id, code, description, discount_type, discount_value, 500 from public.promotions where code='REWARDS5'`,
      ),
    ).rejects.toThrow(/Wayne's Rewards offer/);

    const memberOrder = await database.query<{ id: string }>(
      `insert into public.orders(order_number,customer_id,source,fulfillment_type,status,payment_status,payment_method,customer_name_snapshot,customer_phone_snapshot,pricing_snapshot,idempotency_key,subtotal_cents,total_cents)
         values('W-16-2','${memberId}','online','pickup','placed','unpaid','cash','Regular Rita','+15085550111','{}'::jsonb,'phase16-member-0123456789',1500,1500) returning id`,
    );
    await expect(
      database.query(
        `insert into public.order_discounts(order_id,promotion_id,code_snapshot,description_snapshot,discount_type_snapshot,discount_value_snapshot,amount_cents)
           select '${memberOrder.rows[0]!.id}', id, code, description, discount_type, discount_value, 500 from public.promotions where code='REWARDS5'`,
      ),
    ).resolves.toBeDefined();
  });
});
