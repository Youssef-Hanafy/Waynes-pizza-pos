import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ownerId, startTipPostgres } from "./helpers/tip-postgres";
vi.mock("server-only", () => ({}));
describe("customer autosave and order submission across PostgreSQL sessions", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  beforeAll(async () => { db=await startTipPostgres();
    await db.admin.query(`create function public.customer_race_delay() returns trigger language plpgsql as $$ begin perform pg_sleep(0.2); return new; end $$;
      create trigger customer_race_delay before insert on public.customers for each row execute function public.customer_race_delay()`);
  },120_000);
  afterEach(async () => { await db.closeTestClients(); });
  afterAll(async () => { await db?.stop(); });
  async function call(name:string,payload:object) {
    const client=await db.connect();
    try {
      await client.query("begin; set local role authenticated");
      await client.query("select set_config('request.jwt.claim.sub',$1,true)",[ownerId]);
      const result=await client.query(`select public.${name}($1) value`,[JSON.stringify(payload)]);
      await client.query("commit");return result.rows[0].value;
    } catch(error){await client.query("rollback");throw error;}
  }
  it("allows autosave and order submission to share one customer without a unique-key failure",async()=>{
    const f=await db.fixture();
    const item=(await db.admin.query("select menu_item_id from public.order_items where order_id=$1 limit 1",[f.orderId])).rows[0].menu_item_id;
    const phone="5085550181",identity={phone,first_name:"Concurrent",last_name:"Customer",email:""};
    const results=await Promise.allSettled([
      call("wayne_pos_remember_customer",identity),
      call("wayne_create_pos_order",{...identity,idempotency_key:randomUUID(),customer_mode:"identified",source:"phone",fulfillment_type:"pickup",payment_method:"test_manual",items:[{menu_item_id:item,quantity:1,modifiers:[]}]})
    ]);
    expect(results.filter(r=>r.status==="rejected")).toEqual([]);
    const customer=(await db.admin.query("select id from public.customers where phone_normalized='+15085550181'")).rows;
    expect(customer).toHaveLength(1);
    const order=(results[1] as PromiseFulfilledResult<{id:string}>).value;
    expect((await db.admin.query("select customer_id from public.orders where id=$1",[order.id])).rows[0].customer_id).toBe(customer[0].id);
  });
  it("retains one customer and one address when two autosaves overlap",async()=>{
    const identity={phone:"5085550182",first_name:"Concurrent",last_name:"Address",address:{address1:"93 West Boylston St",address2:"",city:"Worcester",state:"MA",postal_code:"01606"}};
    const results=await Promise.allSettled([call("wayne_pos_remember_customer",identity),call("wayne_pos_remember_customer",identity)]);
    expect(results.filter(r=>r.status==="rejected")).toEqual([]);
    expect((await db.admin.query("select count(*)::int n from public.customers where phone_normalized='+15085550182'")).rows[0].n).toBe(1);
    expect((await db.admin.query("select count(*)::int n from public.customer_addresses a join public.customers c on c.id=a.customer_id where c.phone_normalized='+15085550182'")).rows[0].n).toBe(1);
  });
});
