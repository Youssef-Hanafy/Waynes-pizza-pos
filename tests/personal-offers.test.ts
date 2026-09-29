import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePromotionForm } from "@/lib/promotions/schemas";

const directory = resolve(process.cwd(), "supabase/migrations");
const files = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();

const ownerId = "71000000-0000-4000-8000-000000000001";
const ritaId = "71000000-0000-4000-8000-000000000010";
const samId = "71000000-0000-4000-8000-000000000011";
const quietId = "71000000-0000-4000-8000-000000000012";

type Role = "anon" | "authenticated" | "service_role";
type Offers = { member: boolean; link_key?: string | null; offers: { code: string; personal: boolean }[] };

describe("personal offer codes, personal links and tracked redemptions", () => {
  const database = new PGlite({ extensions: { pgcrypto } });
  let segmentId = "";

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
  const one = async <T>(sql: string) => (await database.query<T>(sql)).rows[0]!;
  const outbox = async (type: string) =>
    (await database.query<{ payload: { data: Record<string, unknown> } }>(`select payload from public.integration_outbox where event_type = $1 order by created_at`, [type])).rows;
  const order = async (number: string, customerId: string) =>
    (await one<{ id: string }>(`insert into public.orders(order_number,customer_id,source,fulfillment_type,status,payment_status,payment_method,customer_name_snapshot,customer_phone_snapshot,pricing_snapshot,idempotency_key,subtotal_cents,total_cents)
      values('${number}','${customerId}','online','pickup','placed','unpaid','cash','Test','+15085550000','{}'::jsonb,'personal-offers-${number}-0123456789',2500,2500) returning id`)).id;
  const applyCode = (orderId: string, code: string) =>
    database.query(`insert into public.order_discounts(order_id,promotion_id,code_snapshot,description_snapshot,discount_type_snapshot,discount_value_snapshot,amount_cents)
      select '${orderId}', id, code, description, discount_type, discount_value, 500 from public.promotions where code = '${code}'`);

  beforeAll(async () => {
    await database.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb not null default '{}'::jsonb,last_sign_in_at timestamptz); create schema storage; create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null);`);
    await database.exec("grant usage on schema public to anon, authenticated, service_role;");
    for (const file of files) await database.exec(readFileSync(resolve(directory, file), "utf8"));
    await database.exec(`
      insert into auth.users(id,email) values ('${ownerId}','owner@offers.test');
      update public.profiles set active=true, role_id=(select id from public.roles where code='owner') where id='${ownerId}';
      insert into public.customers(id,first_name,last_name,phone_normalized,sms_marketing_opt_in)
        values('${ritaId}','Rita','Regular','+15085550111',true),
              ('${samId}','Sam','Second','+15085550333',true),
              ('${quietId}','Quinn','Quiet','+15085550222',false);
    `);
    segmentId = (await one<{ id: string }>(`select id from public.customer_segments where name = '30-day inactive'`)).id;
    await database.exec(`
      insert into public.promotions(code,description,discount_type,discount_value,minimum_order_cents,private,code_mode,delivery,audience_segment_id,crm_event_name,code_valid_days)
        values('WINBACK','We miss you: $5 off','fixed',500,0,true,'personal','segment_entered','${segmentId}','winback',14);
      insert into public.promotions(code,description,discount_type,discount_value,minimum_order_cents,private,members_only,code_mode,delivery)
        values('WEEK','$3 off this week','fixed',300,0,true,true,'personal','publish');
      insert into public.promotions(code,description,discount_type,discount_value,minimum_order_cents)
        values('FLYER5','Five off for everyone','fixed',500,0);
    `);
  }, 120_000);
  afterAll(async () => database.close());

  it("sends a regular who lapses their own win-back code, once, and tells the CRM", async () => {
    await database.exec(`insert into public.customer_segment_memberships(customer_id,segment_id,entered_at,evaluated_at) values('${ritaId}','${segmentId}',now(),now())`);
    const code = await one<{ code: string; ends_at: string; customer_id: string }>(`select code, ends_at, customer_id from public.promotions where parent_promotion_id = (select id from public.promotions where code='WINBACK')`);
    expect(code.code).toMatch(/^WINBACK-[0-9A-F]{6}$/);
    expect(code.customer_id).toBe(ritaId);
    expect(Date.parse(code.ends_at) - Date.now()).toBeGreaterThan(13 * 86_400_000);
    const [event] = await outbox("customer.offer.winback");
    expect(event!.payload.data.reward).toMatchObject({ code: code.code, kind: "winback", discount_cents: 500 });

    // Leaving and coming back inside 60 days does not send a second code.
    await database.exec(`update public.customer_segment_memberships set active=false, exited_at=now() where customer_id='${ritaId}' and segment_id='${segmentId}' and active;
      insert into public.customer_segment_memberships(customer_id,segment_id,entered_at,evaluated_at) values('${ritaId}','${segmentId}',now(),now())`);
    expect((await outbox("customer.offer.winback")).length).toBe(1);

    // No text consent → no code, no text.
    await database.exec(`insert into public.customer_segment_memberships(customer_id,segment_id,entered_at,evaluated_at) values('${quietId}','${segmentId}',now(),now())`);
    expect((await one<{ count: number }>(`select count(*)::int as count from public.promotions where customer_id='${quietId}'`)).count).toBe(0);
  });

  it("publishes a weekly offer: a code per member and one link text each per day", async () => {
    const offerId = (await one<{ id: string }>(`select id from public.promotions where code='WEEK'`)).id;
    await expect(call("authenticated", null, `public.wayne_publish_offer('${offerId}', true)`)).rejects.toThrow(/permission/i);
    const first = await call<{ issued: number; texted: number }>("authenticated", ownerId, `public.wayne_publish_offer('${offerId}', true)`);
    expect(first).toEqual({ issued: 2, texted: 2 });
    const again = await call<{ issued: number; texted: number }>("authenticated", ownerId, `public.wayne_publish_offer('${offerId}', true)`);
    expect(again).toEqual({ issued: 0, texted: 0 });
    const texts = await outbox("customer.offers.published");
    expect(texts.length).toBe(2);
    const reward = texts[0]!.payload.data.reward as { code: string; link_key: string };
    expect(reward.code).toMatch(/^[a-z2-9]{10}$/);
    expect(reward.code).toBe(reward.link_key);
  });

  it("opens a member's offers from their link, from a code, or from their phone", async () => {
    const key = (await one<{ offer_link_key: string }>(`select offer_link_key from public.customers where id='${ritaId}'`)).offer_link_key;
    const byLink = await call<Offers>("service_role", null, `public.wayne_member_offers_by_link($1)`, [key]);
    expect(byLink.member).toBe(true);
    expect(byLink.link_key).toBe(key);
    expect(byLink.offers.map((offer) => offer.code.split("-")[0]).sort()).toEqual(["WEEK", "WINBACK"]);
    const winback = byLink.offers.find((offer) => offer.code.startsWith("WINBACK"))!.code;
    expect((await call<Offers>("service_role", null, `public.wayne_member_offers_by_link($1)`, [winback.toLowerCase()])).member).toBe(true);
    expect((await call<Offers>("service_role", null, `public.wayne_member_offers('(508) 555-0111')`)).offers.length).toBe(2);
    expect((await call<Offers>("service_role", null, `public.wayne_member_offers_by_link('not-a-key')`)).member).toBe(false);
    await expect(call("anon", null, `public.wayne_member_offers_by_link('x')`)).rejects.toThrow(/permission denied/i);
    // Templates and personal codes never reach the public deals list.
    const deals = JSON.stringify(await call("anon", null, "public.wayne_public_promotions()"));
    expect(deals).toContain("FLYER5");
    expect(deals).not.toContain("WINBACK");
    expect(deals).not.toContain("WEEK");
  });

  it("only lets the owner use a personal code, never the template, and reports the sale", async () => {
    const ritaOrder = await order("W-PO-1", ritaId);
    await expect(applyCode(ritaOrder, "WINBACK")).rejects.toThrow(/personal offer/);
    const samCode = (await one<{ code: string }>(`select code from public.promotions where customer_id='${samId}' and code like 'WEEK-%'`)).code;
    await expect(applyCode(ritaOrder, samCode)).rejects.toThrow(/another Wayne's Rewards member/);
    const ritaCode = (await one<{ code: string }>(`select code from public.promotions where customer_id='${ritaId}' and code like 'WINBACK-%'`)).code;
    await expect(applyCode(ritaOrder, ritaCode)).resolves.toBeDefined();

    await database.exec(`update public.orders set status='ready' where id='${ritaOrder}'; update public.orders set status='completed' where id='${ritaOrder}';`);
    const [redeemed] = await outbox("customer.offer.redeemed");
    expect(redeemed!.payload.data).toMatchObject({ order_id: ritaOrder, total_cents: 2500 });
    expect(redeemed!.payload.data.reward).toMatchObject({ code: ritaCode, kind: "winback" });

    const stats = await run<{ promotion_id: string; codes_issued: number; orders_count: number; revenue_cents: number }>(
      "authenticated", ownerId, `select * from public.wayne_promotion_stats() where promotion_id = (select id from public.promotions where code='WINBACK')`);
    expect(stats[0]).toMatchObject({ codes_issued: 1, orders_count: 1 });
    expect(Number(stats[0]!.revenue_cents)).toBe(2500);
  });

  it("clears a removed customer's unused codes and link", async () => {
    await database.exec(`update public.customers set removed_at = now() where id = '${samId}'`);
    expect((await one<{ count: number }>(`select count(*)::int as count from public.promotions where customer_id='${samId}'`)).count).toBe(0);
    expect((await one<{ offer_link_key: string | null }>(`select offer_link_key from public.customers where id='${samId}'`)).offer_link_key).toBeNull();
  });

  it("builds the admin form into a personal or public promotion", () => {
    const base = { code: "winback", description: "", discount_type: "fixed", discount_amount: "5", minimum_order: "0", fulfillment_type: "", starts_at: "", ends_at: "", total_usage_limit: "", per_customer_limit: "", active: "on" };
    const auto = parsePromotionForm({ ...base, code_mode: "personal", delivery: "segment_entered", audience_segment_id: segmentId, code_valid_days: "14", reissue_after_days: "", crm_event_name: "" }, "America/New_York");
    expect(auto.ok && auto.row).toMatchObject({ code: "WINBACK", code_mode: "personal", private: true, delivery: "segment_entered", crm_event_name: "winback", code_valid_days: 14 });
    expect(parsePromotionForm({ ...base, code_mode: "personal", delivery: "segment_entered", audience_segment_id: "" }, "America/New_York").ok).toBe(false);
    const flyer = parsePromotionForm({ ...base, code: "flyer5" }, "America/New_York");
    // A public code never touches `private`, so editing a welcome code can't publish it.
    expect(flyer.ok && flyer.row).toMatchObject({ code_mode: "public", delivery: "publish", crm_event_name: null });
    expect(flyer.ok && flyer.row.private).toBeUndefined();
  });
});
