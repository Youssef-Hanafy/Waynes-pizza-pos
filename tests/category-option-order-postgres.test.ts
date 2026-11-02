import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTipPostgres } from "./helpers/tip-postgres";
vi.mock("server-only", () => ({}));

/**
 * "The modifiers are moving around and in different spots" (Ehab, 2026-11-01):
 * every item in a category shows its options and sections in ONE shared order,
 * on real PostgreSQL with every migration.
 */
describe("one option order per category (real PostgreSQL)", () => {
  let db: Awaited<ReturnType<typeof startTipPostgres>>;
  const cat = "7a000000-0000-4000-8000-000000000001";
  const other = "7a000000-0000-4000-8000-000000000002";
  beforeAll(async () => {
    db = await startTipPostgres();
    await db.admin.query(`insert into public.menu_categories(id,name) values('${cat}','Steak Subs'),('${other}','Salads')`);
    // Three subs, each with its own copy of Vegetables (and Sauces) in a different order — like production.
    const subs: Array<[string, string[], string[], string[]]> = [
      ["BBQ Steak", ["Hot Pepper", "Lettuce", "Tomato", "GR Onion", "Pickles"], ["Mayo", "BBQ"], ["veg", "sauce"]],
      ["Hot Pastrami", ["Hot Pepper", "GR Onion", "Lettuce"], ["BBQ", "Mayo"], ["sauce", "veg"]],
      ["Steak & Mushroom", ["Tomato", "Lettuce", "GR Mushrooms", "Hot Pepper"], ["Mayo"], ["veg", "sauce"]],
    ];
    for (const [name, veg, sauce, order] of subs) {
      const item = (await db.admin.query("insert into public.menu_items(category_id,name,base_price_cents,pos_visible) values($1,$2,1000,true) returning id", [cat, name])).rows[0].id;
      for (const [label, choices] of [["Vegetables", veg], ["Sauces", sauce]] as const) {
        const group = (await db.admin.query("insert into public.modifier_groups(name,customer_label,min_select,max_select) values($1,$2,0,10) returning id", [`${name} – ${label}`, label])).rows[0].id;
        for (const [index, choice] of choices.entries()) {
          await db.admin.query("insert into public.modifier_choices(modifier_group_id,name,price_delta_cents,sort_order) values($1,$2,0,$3)", [group, choice, index]);
        }
        await db.admin.query("insert into public.menu_item_modifier_groups(menu_item_id,modifier_group_id,sort_order) values($1,$2,$3)", [item, group, order.indexOf(label === "Vegetables" ? "veg" : "sauce")]);
      }
    }
  }, 180_000);
  afterAll(async () => { await db?.stop(); });

  const optionOrder = async (label: string) => (await db.admin.query(`
    select item.name as item, array_agg(c.name order by c.sort_order, c.name) as names
    from public.menu_items item
    join public.menu_item_modifier_groups link on link.menu_item_id = item.id and link.active
    join public.modifier_groups g on g.id = link.modifier_group_id and g.customer_label = $2
    join public.modifier_choices c on c.modifier_group_id = g.id and c.active
    where item.category_id = $1 group by item.name order by item.name`, [cat, label])).rows as Array<{ item: string; names: string[] }>;
  const sectionOrder = async () => (await db.admin.query(`
    select item.name as item, array_agg(g.customer_label order by link.sort_order, g.name) as labels
    from public.menu_items item
    join public.menu_item_modifier_groups link on link.menu_item_id = item.id and link.active
    join public.modifier_groups g on g.id = link.modifier_group_id
    where item.category_id = $1 group by item.name order by item.name`, [cat])).rows as Array<{ item: string; labels: string[] }>;

  it("puts every option at the same spot on every item and the sections in the same order", async () => {
    const result = (await db.admin.query("select public._wayne_align_category_option_order($1) value", [cat])).rows[0].value;
    expect(result.choices_moved).toBeGreaterThan(0);
    // The fullest copy (BBQ Steak) sets the order; options it lacks (GR Mushrooms) go after.
    const reference = ["Hot Pepper", "Lettuce", "Tomato", "GR Onion", "Pickles", "GR Mushrooms"];
    for (const row of await optionOrder("Vegetables")) {
      expect(row.names).toEqual(reference.filter((name) => row.names.includes(name)));
    }
    for (const row of await optionOrder("Sauces")) expect(row.names).toEqual(["Mayo", "BBQ"].filter((name) => row.names.includes(name)));
    // Vegetables usually come first, so they come first on every sub.
    expect(new Set((await sectionOrder()).map((row) => row.labels.join(",")))).toEqual(new Set(["Vegetables,Sauces"]));
  });

  it("is re-runnable, changes nothing else, and only staff with menu access may run it", async () => {
    const again = (await db.admin.query("select public._wayne_align_category_option_order($1) value", [cat])).rows[0].value;
    expect(again).toEqual({ choices_moved: 0, sections_moved: 0 });
    const client = await db.connect();
    try {
      await client.query("begin; set local role anon");
      await expect(client.query("select public.wayne_align_category_option_order($1)", [cat])).rejects.toThrow();
    } finally { await client.query("rollback").catch(() => undefined); }
    // An empty category is fine.
    expect((await db.admin.query("select public._wayne_align_category_option_order($1) value", [other])).rows[0].value).toEqual({ choices_moved: 0, sections_moved: 0 });
  });
});
