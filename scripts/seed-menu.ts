/**
 * Loads Wayne's printed menu into the database the one time, so that every item,
 * size and option exists as an ordinary row an owner can edit in Admin -> Menu.
 *
 * The rule this script follows is: create what is missing, change nothing that
 * already exists. Re-running it after Ehab has corrected a price or hidden an
 * item will not undo that — it will only fill in whatever is new. Nothing is
 * ever deleted or archived from here.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run seed:menu
 *
 * Add --visible to make the new items customer-facing immediately. Without it
 * everything lands hidden from customers (but usable on the POS), so the menu can
 * be proofed against the paper menu before anyone can order from it.
 */
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { categories, modifierGroups } from "./menu-data";

const environmentSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
});

const customerVisible = process.argv.includes("--visible");
const tally = { created: 0, existing: 0 };
const note = (created: boolean, label: string) => {
  if (created) { tally.created += 1; console.log(`  + ${label}`); } else { tally.existing += 1; }
};

async function main() {
  const environment = environmentSchema.parse(process.env);
  const supabase = createClient(environment.NEXT_PUBLIC_SUPABASE_URL, environment.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const take = <T>({ data, error }: { data: T | null; error: { message: string } | null }, what: string): T => {
    if (error) throw new Error(`${what}: ${error.message}`);
    if (data === null) throw new Error(`${what}: no row returned`);
    return data;
  };

  console.log(`Loading the menu${customerVisible ? "" : " (hidden from customers until you publish it)"}…\n`);

  // --- Modifier groups and their choices -----------------------------------
  const groupIds = new Map<string, string>();
  for (const [index, group] of modifierGroups.entries()) {
    const found = take(await supabase.from("modifier_groups").select("id").eq("name", group.name).maybeSingle(), `read group ${group.name}`) as { id: string } | null;
    let id = found?.id;
    if (!id) {
      const inserted = take(await supabase.from("modifier_groups").insert({
        name: group.name,
        customer_label: group.customerLabel,
        min_select: group.minSelect ?? 0,
        max_select: group.maxSelect ?? 1,
        required: group.required ?? false,
        allow_quantities: group.allowQuantities ?? false,
        sort_order: index * 10,
      }).select("id").single(), `create group ${group.name}`) as { id: string };
      id = inserted.id;
    }
    note(!found, `option group "${group.name}"`);
    groupIds.set(group.key, id);

    for (const [choiceIndex, choice] of group.choices.entries()) {
      const existing = take(await supabase.from("modifier_choices").select("id").eq("modifier_group_id", id).eq("name", choice.name).maybeSingle(), `read choice ${choice.name}`) as { id: string } | null;
      if (existing) { tally.existing += 1; continue; }
      take(await supabase.from("modifier_choices").insert({
        modifier_group_id: id,
        name: choice.name,
        price_delta_cents: choice.priceDeltaCents ?? 0,
        sort_order: choiceIndex * 10,
      }).select("id").single(), `create choice ${choice.name}`);
      tally.created += 1;
    }
  }

  // --- Categories, items, sizes and links -----------------------------------
  for (const [categoryIndex, category] of categories.entries()) {
    const foundCategory = take(await supabase.from("menu_categories").select("id").eq("name", category.name).is("archived_at", null).maybeSingle(), `read category ${category.name}`) as { id: string } | null;
    let categoryId = foundCategory?.id;
    if (!categoryId) {
      const inserted = take(await supabase.from("menu_categories").insert({
        name: category.name,
        description: category.description ?? "",
        sort_order: (categoryIndex + 1) * 10,
        customer_visible: true,
      }).select("id").single(), `create category ${category.name}`) as { id: string };
      categoryId = inserted.id;
    }
    console.log(`${category.name}`);
    note(!foundCategory, `category "${category.name}"`);

    for (const [itemIndex, item] of category.items.entries()) {
      const foundItem = take(await supabase.from("menu_items").select("id").eq("category_id", categoryId).eq("name", item.name).is("archived_at", null).maybeSingle(), `read item ${item.name}`) as { id: string } | null;
      let itemId = foundItem?.id;
      if (!itemId) {
        const inserted = take(await supabase.from("menu_items").insert({
          category_id: categoryId,
          name: item.name,
          description: item.description ?? "",
          // An item with sizes prices from the chosen size; the base price is unused.
          base_price_cents: item.variants ? 0 : (item.priceCents ?? 0),
          sort_order: (itemIndex + 1) * 10,
          customer_visible: customerVisible,
          pos_visible: true,
        }).select("id").single(), `create item ${item.name}`) as { id: string };
        itemId = inserted.id;
      }
      note(!foundItem, `${item.name}`);

      for (const [variantIndex, variant] of (item.variants ?? []).entries()) {
        const existing = take(await supabase.from("menu_item_variants").select("id").eq("menu_item_id", itemId).eq("name", variant.name).is("archived_at", null).maybeSingle(), `read size ${variant.name}`) as { id: string } | null;
        if (existing) { tally.existing += 1; continue; }
        take(await supabase.from("menu_item_variants").insert({
          menu_item_id: itemId,
          name: variant.name,
          price_cents: variant.priceCents,
          sku: "",
          sort_order: variantIndex * 10,
        }).select("id").single(), `create size ${variant.name} of ${item.name}`);
        tally.created += 1;
      }

      for (const [groupIndex, key] of (item.groups ?? []).entries()) {
        const groupId = groupIds.get(key);
        if (!groupId) throw new Error(`${item.name} refers to an unknown option group "${key}"`);
        const existing = take(await supabase.from("menu_item_modifier_groups").select("menu_item_id").eq("menu_item_id", itemId).eq("modifier_group_id", groupId).maybeSingle(), `read link ${key}`) as { menu_item_id: string } | null;
        if (existing) { tally.existing += 1; continue; }
        const { error } = await supabase.from("menu_item_modifier_groups").insert({
          menu_item_id: itemId, modifier_group_id: groupId, sort_order: groupIndex * 10,
        });
        if (error) throw new Error(`link ${key} to ${item.name}: ${error.message}`);
        tally.created += 1;
      }
    }
  }

  const itemCount = categories.reduce((total, category) => total + category.items.length, 0);
  console.log(`\n${tally.created} rows created, ${tally.existing} already there.`);
  console.log(`${categories.length} categories, ${itemCount} items.`);
  if (!customerVisible) {
    console.log("\nNew items are hidden from customers. Proof them against the paper menu in");
    console.log("Admin -> Menu, then make them visible there (or re-run with --visible).");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown menu seed error";
  console.error(`\nMenu seed failed: ${message}`);
  console.error("Nothing is rolled back, but the seed only ever creates missing rows, so it is safe to fix and run again.");
  process.exitCode = 1;
});
