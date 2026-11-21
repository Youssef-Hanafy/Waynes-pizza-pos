import { eggRollPricing } from "./fixtures/egg-roll-pricing";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTipPostgres, ownerId } from "./helpers/tip-postgres";
import { publicMenuSchema, type PublicMenu } from "@/lib/menu/schemas";
import { cartLineUnitCents } from "@/lib/orders/cart";

let db: Awaited<ReturnType<typeof startTipPostgres>>;
const category = "79000000-0000-4000-8000-000000000002";
const base = eggRollPricing;
let first: string, second: string;
beforeAll(async () => {
  db = await startTipPostgres();
  await db.admin.query(`update public.store_settings set business_hours=(select jsonb_object_agg(day,'{"closed":false,"open":"00:00","close":"24:00"}'::jsonb) from unnest(array['sunday','monday','tuesday','wednesday','thursday','friday','saturday']) day)`);
  first = await call("wayne_create_menu_item", [base]);
  second = await call("wayne_create_menu_item", [{ ...base, name: "Buffalo Steak Egg Roll" }]);
}, 60_000);
afterAll(async () => { await db?.stop(); });
async function call(name: string, args: unknown[] = [], service = false, actor = ownerId) {
  const client = await db.connect();
  try {
    await client.query(`begin;set local role ${service ? "service_role" : "authenticated"}`);
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [actor]);
    const result = await client.query(`select public.${name}(${args.map((_, i) => `$${i+1}`).join(",")}) value`, args.map(arg => arg !== null && typeof arg === "object" ? JSON.stringify(arg) : arg));
    await client.query("commit"); return result.rows[0].value;
  } catch (error) { await client.query("rollback"); throw error; }
  finally { await db.disconnect(client); }
}
async function menus() {
  return Promise.all(["wayne_public_menu", "wayne_pos_menu"].map(async name => publicMenuSchema.parse(await call(name))));
}
function item(menu: PublicMenu, id: string) { return menu.flatMap(c => c.items).find(i => i.id === id)!; }

it("publishes Small=1, One Size=1 and Large=2 in both menus", async () => {
  for (const menu of await menus()) {
    expect(item(menu, second).modifier_groups[0].size_rules?.map(r => [r.variant_name,r.included_count])).toEqual(expect.arrayContaining([["Small",1],["One Size",1],["Large",2]]));
  }
});
it("uses one Marinara price over legacy size prices and flat extra prices, online and POS", async () => {
  await call("wayne_save_shared_sauce_prices", [[{ key: "marinara", price_cents: 85 }]]);
  for (const menu of await menus()) {
    for (const id of [first, second]) {
      const current = item(menu,id), choice = current.modifier_groups[0].choices[0];
      expect(choice.shared_price_cents).toBe(85);
      for (const variant of current.variants) {
        const free = variant.name === "Large" ? 2 : 1;
        const line = { line_id: randomUUID(), menu_item_id: id, variant_id: variant.id, quantity: 1, special_instructions: "", modifiers: [{ choice_id: choice.id, quantity: free+1 }] };
        expect(cartLineUnitCents(menu,line)).toBe(1085);
        expect((await db.admin.query("select public.wayne_modifier_unit_cents($1,$2) value", [variant.id, choice.id])).rows[0].value).toBe(85);
        for (const online of [false,true]) {
          const order = await call(online ? "wayne_create_test_order" : "wayne_create_pos_order", [{ idempotency_key: randomUUID(), customer_mode: "walk_in", source: online ? "online" : "pos", fulfillment_type: "pickup", payment_method: "test_manual", first_name: "Synthetic", last_name: "Sauce Test", phone: "5085550198", email: "sauce@example.invalid", items: [line] }], online);
          expect((await db.admin.query("select line_total_cents from order_items where order_id=$1",[order.id])).rows[0].line_total_cents).toBe(1085);
        }
      }
    }
  }
});
it("changes one item's One Size allowance and keeps its sibling and Large allowance", async () => {
  const current = item((await menus())[0],second);
  const row = (await db.admin.query("select menu_revision from menu_items where id=$1",[second])).rows[0];
  await call("wayne_update_menu_item", [second, { ...base, name: current.name, expected_revision: row.menu_revision,
    variants: current.variants.map((v, sort_order) => ({ ...v, sku: "", sort_order })), modifier_groups: [{ ...base.modifier_groups[0], id: current.modifier_groups[0].id, size_rules: base.modifier_groups[0].size_rules.map(r => ({ ...r, included_count: r.variant_name === "One Size" ? 0 : r.included_count })) }] }]);
  for (const menu of await menus()) {
    expect(item(menu,first).modifier_groups[0].size_rules?.find(r => r.variant_name === "One Size")?.included_count).toBe(1);
    expect(item(menu,second).modifier_groups[0].size_rules?.find(r => r.variant_name === "One Size")?.included_count).toBe(0);
    expect(item(menu,second).modifier_groups[0].size_rules?.find(r => r.variant_name === "Large")?.included_count).toBe(2);
    expect(item(menu,second).modifier_groups[0].choices[0].shared_price_cents).toBe(85);
  }
});
it("category edits change only the chosen size and preserve item exceptions", async () => {
  await call("wayne_save_category_menu_options", [category, { sections: [], size_rules: [{ label: "Sauces", rules: [{ size_name: "Small", included_count: 2, max_portions: 20, extra_each_cents: null }] }] }]);
  for (const menu of await menus()) {
    for (const id of [first,second]) expect(item(menu,id).modifier_groups[0].size_rules?.find(r => r.variant_name === "Small")?.included_count).toBe(2);
    expect(item(menu,second).modifier_groups[0].size_rules?.find(r => r.variant_name === "One Size")?.included_count).toBe(0);
  }
});
it("rejects unauthorized and malformed shared price saves without changing the price", async () => {
  const cashier = randomUUID();
  await db.admin.query("insert into auth.users(id,email) values($1,'sauce-cashier@example.invalid')",[cashier]);
  await expect(call("wayne_save_shared_sauce_prices", [[{ key:"marinara",price_cents:99 }]],false,cashier)).rejects.toThrow(/permission/i);
  await expect(call("wayne_save_shared_sauce_prices", [[{ key:"marinara",price_cents:99 },{ key:"marinara",price_cents:-1 }]])).rejects.toThrow(/valid sauce price/i);
  expect(item((await menus())[0],first).modifier_groups[0].choices[0].shared_price_cents).toBe(85);
});

it("keeps another business's Marinara independent", async () => {
  const workspace = randomUUID(), group = randomUUID(), choice = randomUUID();
  await db.admin.query("insert into workspaces(id,slug,name) values($1,$2,'Other sauce business')",[workspace,`sauce-${workspace}`]);
  await db.admin.query("insert into modifier_groups(id,workspace_id,name,customer_label) values($1,$2,'Other sauces','Sauces')",[group,workspace]);
  await db.admin.query("insert into modifier_choices(id,workspace_id,modifier_group_id,name,price_delta_cents) values($1,$2,$3,'Marinara',444)",[choice,workspace,group]);
  expect((await db.admin.query("select public.wayne_shared_sauce_price($1) value",[choice])).rows[0].value).toBeNull();
  await call("wayne_save_shared_sauce_prices", [[{key:"marinara",price_cents:95}]]);
  expect((await db.admin.query("select price_delta_cents from modifier_choices where id=$1",[choice])).rows[0].price_delta_cents).toBe(444);
});
