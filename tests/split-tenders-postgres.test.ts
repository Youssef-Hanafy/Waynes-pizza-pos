import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ownerId, startTipPostgres } from "./helpers/tip-postgres";
vi.mock("server-only", () => ({}));

describe("split tenders on real PostgreSQL", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  const pizza = randomUUID(), pickGroup = randomUUID(), paidGroup = randomUUID(), pick = randomUUID(), topping = randomUUID(), variant = randomUUID();
  beforeAll(async () => {
    const migration = "20261128080000_split_tenders_and_repeat_modifiers.sql";
    db = await startTipPostgres({ skipMigration: migration });
    await db.admin.query("insert into public.menu_items(id,category_id,name,base_price_cents,pos_visible) select $1,category_id,'One Topping Pizza',1000,true from public.menu_items where name='Test item'", [pizza]);
    await db.admin.query("insert into public.menu_item_variants(id,menu_item_id,name,price_cents) values($1,$2,'Large',1000)", [variant,pizza]);
    await db.admin.query("insert into public.modifier_groups(id,name,customer_label,min_select,max_select,required,allow_quantities) values($1,'One Topping Pizza – Topping','Choose your topping',1,1,true,false),($2,'Pizza – Meats','Meats',0,10,false,true)", [pickGroup,paidGroup]);
    await db.admin.query("insert into public.menu_item_modifier_groups(menu_item_id,modifier_group_id) values($1,$2),($1,$3)", [pizza,pickGroup,paidGroup]);
    await db.admin.query("insert into public.modifier_choices(id,modifier_group_id,name,price_delta_cents) values($1,$2,'Pepperoni',0),($3,$4,'Pepperoni',100)", [pick,pickGroup,topping,paidGroup]);
    await db.admin.query("insert into public.modifier_choice_variant_prices(modifier_choice_id,menu_item_variant_id,price_delta_cents) values($1,$2,200)", [topping,variant]);
    await db.admin.query(await readFile(`supabase/migrations/${migration}`, "utf8"));
  }, 180_000);
  afterAll(async () => { await db?.stop(); });
  async function rpc(sql: string, args: unknown[]) {
    const client = await db.connect();
    try {
      await client.query("begin; set local role authenticated");
      await client.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
      const value = (await client.query(sql, args)).rows[0].value;
      await client.query("commit"); return value;
    } catch (error) { await client.query("rollback"); throw error; }
  }
  async function order() {
    const f = await db.fixture();
    await db.admin.query("delete from public.payments where id=$1", [f.paymentId]);
    await db.admin.query("update public.orders set payment_status='unpaid' where id=$1", [f.orderId]);
    return f;
  }
  async function state(id: string) {
    return (await db.admin.query("select payment_status, total_cents, public.wayne_order_paid_cents(id) paid from public.orders where id=$1", [id])).rows[0];
  }
  it("one topping stays included and repeated taps charge the same size price as the extra topping", async () => {
    for (const portions of [1,2,3]) {
      const result = await rpc("select public.wayne_create_pos_order($1) value", [{ idempotency_key: randomUUID(), customer_mode: "walk_in", source: "pos", fulfillment_type: "pickup", payment_method: "test_manual", items: [{ menu_item_id: pizza, variant_id: variant, quantity: 1, modifiers: [{ choice_id: pick, quantity: portions }], special_instructions: "" }] }]);
      const saved = (await db.admin.query("select unit_price_cents, modifier_unit_total_cents from public.order_items where order_id=$1", [result.id])).rows[0];
      expect(saved.unit_price_cents + saved.modifier_unit_total_cents).toBe(1000 + (portions-1)*200);
    }
    expect((await db.admin.query("select allow_quantities,max_select from public.modifier_groups where id=$1", [pickGroup])).rows[0]).toMatchObject({ allow_quantities: true, max_select: 20 });
  });
  it("cash + card: keeps the balance open, opens drawer, retries once, then closes for the exact total", async () => {
    const f = await order();
    const cash = { order_id: f.orderId, shift_id: "", amount_cents: 500, tendered_cents: 1000, idempotency_key: randomUUID() };
    const first = await rpc("select public.wayne_take_cash_payment($1) value", [cash]);
    expect(first).toMatchObject({ amount_cents: 500, change_cents: 500 });
    expect(await state(f.orderId)).toMatchObject({ payment_status: "unpaid", paid: 500 });
    expect((await db.admin.query("select count(*)::int n from public.print_jobs where order_id=$1 and job_type='drawer_kick'", [f.orderId])).rows[0].n).toBe(1);
    expect(await rpc("select public.wayne_take_cash_payment($1) value", [cash])).toMatchObject({ duplicate: true, payment_id: first.payment_id });
    await rpc("select public.wayne_record_card_payment($1) value", [{ order_id: f.orderId, amount_cents: f.amount - 500, idempotency_key: randomUUID() }]);
    expect(await state(f.orderId)).toMatchObject({ payment_status: "paid", paid: f.amount, total_cents: f.amount });
  });
  it("card + card + cash: only the last payment closes the order", async () => {
    const f = await order();
    for (const amount of [400, 600]) {
      await rpc("select public.wayne_record_card_payment($1) value", [{ order_id: f.orderId, amount_cents: amount, idempotency_key: randomUUID() }]);
      expect((await state(f.orderId)).payment_status).toBe("unpaid");
    }
    await rpc("select public.wayne_take_cash_payment($1) value", [{ order_id: f.orderId, shift_id: "", tendered_cents: f.amount - 1000, idempotency_key: randomUUID() }]);
    expect(await state(f.orderId)).toMatchObject({ payment_status: "paid", paid: f.amount });
  });
  it("refuses zero, overpayment and competing card requests", async () => {
    const f = await order();
    for (const amount of [0, -1, f.amount + 1]) await expect(rpc("select public.wayne_record_card_payment($1) value", [{ order_id: f.orderId, amount_cents: amount, idempotency_key: randomUUID() }])).rejects.toThrow(/amount/i);
    await db.admin.query("update public.payment_provider_settings set provider='stripe'");
    const begun = await rpc("select public.wayne_begin_payment($1) value", [{ order_id: f.orderId, amount_cents: 700, entry: "pos_keyed_card", idempotency_key: randomUUID() }]);
    expect(begun.amount_cents).toBe(700);
    await expect(rpc("select public.wayne_record_card_payment($1) value", [{ order_id: f.orderId, amount_cents: 500, idempotency_key: randomUUID() }])).rejects.toThrow(/already open/i);
  });
  it("test cards support the same two-card flow", async () => {
    const f = await order();
    await db.admin.query("update public.orders set is_test=true where id=$1", [f.orderId]);
    for (const amount of [800, f.amount - 800]) {
      const result = await rpc("select public.wayne_pos_test_card_payment($1,false,'card_reader',$2,$3) value", [f.orderId, randomUUID(), amount]);
      expect(result.amount_cents).toBe(amount);
      expect((await state(f.orderId)).payment_status).toBe(amount === 800 ? "unpaid" : "paid");
    }
  });
});
