import { readFile } from "node:fs/promises";
import type { Client } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { publicMenuSchema } from "@/lib/menu/schemas";
import { eggRollPricing } from "./fixtures/egg-roll-pricing";
import { ownerId, startTipPostgres } from "./helpers/tip-postgres";

const migration = "20261211080000_inherit_category_modifiers.sql";
const categoryId = eggRollPricing.category_id;
const large = { name: "Large", price_cents: 2000, sku: "", sort_order: 0 };
const pizza = { ...eggRollPricing, variants: [large], modifier_groups: [] };
const pepperoni = {
  name: "Pepperoni", price_delta_cents: 175, default_selected: true,
  variant_prices: [{ variant_name: "Large", price_delta_cents: 250 }],
};
const meats = {
  name: "Pizza meats", customer_label: "Meats", min_select: 0, max_select: 20, required: false,
  allow_quantities: true, allow_halves: true, choices: [pepperoni],
  size_rules: [{ variant_name: "Large", included_count: 2, max_portions: 20, extra_each_cents: null }],
};
const sauces = { ...eggRollPricing.modifier_groups[0], size_rules: [] };
let db: Awaited<ReturnType<typeof startTipPostgres>>;
let partyPizzaId: string;

async function withOwner<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin; set local role authenticated");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [ownerId]);
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await db.disconnect(client);
  }
}

async function createItem(payload: object): Promise<string> {
  return withOwner(async (client) => {
    const result = await client.query("select public.wayne_create_menu_item($1) as id", [payload]);
    return result.rows[0].id;
  });
}

async function getMenuItems(id: string) {
  const result = await withOwner((client) =>
    client.query("select public.wayne_public_menu() as online, public.wayne_pos_menu() as pos"),
  );
  return [result.rows[0].online, result.rows[0].pos].map((value) =>
    publicMenuSchema.parse(value).flatMap((category) => category.items).find((item) => item.id === id),
  );
}

beforeAll(async () => {
  db = await startTipPostgres({ skipMigration: migration });
  await db.admin.query("update public.menu_categories set name = 'Build Your Own Pizza' where id = $1", [categoryId]);
  await createItem({ ...pizza, name: "Cheese Pizza", modifier_groups: [sauces, meats] });
  await createItem({
    ...pizza, name: "Two Topping Pizza",
    modifier_groups: [
      { ...meats, name: "Choose 2 toppings", customer_label: "Choose 2 toppings" },
      { ...meats, name: "Choose a crust", customer_label: "Choose a crust", min_select: 1, required: true, size_rules: [] },
      { ...meats, choices: [{ ...pepperoni, name: "Bacon" }] },
    ],
  });
  partyPizzaId = await createItem({ ...pizza, name: "Party Pizza" });
  await db.admin.query(await readFile(`supabase/migrations/${migration}`, "utf8"));
}, 60_000);

afterAll(async () => { await db?.stop(); });

it("backfills Party Pizza with category choices in the online and POS menus", async () => {
  const [online, pos] = await getMenuItems(partyPizzaId);
  expect(pos?.modifier_groups.find((group) => group.customer_label === "Meats")?.allow_halves).toBe(true);
  for (const item of [online, pos]) {
    expect(item?.modifier_groups.map((group) => group.customer_label).sort()).toEqual(["Meats", "Sauces"]);
    const group = item!.modifier_groups.find((group) => group.customer_label === "Meats")!;
    expect(group).toMatchObject({ required: false, allow_quantities: true });
    expect(group.size_rules).toEqual([
      { variant_name: "Large", included_count: 0, max_portions: 20, extra_each_cents: null },
    ]);
    expect(group.choices.map((choice) => choice.name).sort()).toEqual(["Bacon", "Pepperoni"]);
    const inheritedPepperoni = group.choices.find((choice) => choice.name === "Pepperoni");
    expect(inheritedPepperoni).toMatchObject({ default_selected: false, price_delta_cents: 175 });
    const result = await db.admin.query("select public.wayne_modifier_unit_cents($1, $2) as cents", [
      item!.variants[0].id, inheritedPepperoni!.id,
    ]);
    expect(result.rows[0].cents).toBe(250);
  }
});

it("inherits category groups at creation and keeps an explicitly supplied section", async () => {
  const id = await createItem({
    ...pizza, name: "New Pizza", variants: [{ ...large, name: "Party Size" }],
    modifier_groups: [{ ...sauces, choices: [{ ...sauces.choices[0], name: "Pizza Sauce", variant_prices: [] }] }],
  });
  for (const item of await getMenuItems(id)) {
    expect(item?.modifier_groups.map((group) => group.customer_label).sort()).toEqual(["Meats", "Sauces"]);
    expect(item?.modifier_groups.find((group) => group.customer_label === "Sauces")?.choices.map((choice) => choice.name))
      .toEqual(["Pizza Sauce"]);
    expect(item?.variants.map((variant) => variant.name)).toEqual(["Party Size"]);
    const inheritedPepperoni = item?.modifier_groups.find((group) => group.customer_label === "Meats")
      ?.choices.find((choice) => choice.name === "Pepperoni");
    const result = await db.admin.query("select public.wayne_modifier_unit_cents($1, $2) as cents", [
      item!.variants[0].id, inheritedPepperoni!.id,
    ]);
    expect(result.rows[0].cents).toBe(175);
  }
});
