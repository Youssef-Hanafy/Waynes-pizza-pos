/**
 * Prints the menu as idempotent SQL, for loading it where `npm run seed:menu`
 * cannot reach Supabase over the network — pasted into the Supabase SQL editor,
 * for example. Six statements, each guarded, so running it twice creates nothing
 * twice and never touches a row that already exists.
 *
 *   npx tsx scripts/menu-sql.ts > menu-load.sql
 */
import { categories, modifierGroups } from "./menu-data";

const q = (value: string) => `'${value.replace(/'/g, "''")}'`;
const rows = (list: string[]) => list.join(",\n  ");
const groupName = new Map(modifierGroups.map((group) => [group.key, group.name]));

const groupRows: string[] = [];
const choiceRows: string[] = [];
for (const [index, group] of modifierGroups.entries()) {
  groupRows.push(`(${q(group.name)}, ${q(group.customerLabel)}, ${group.minSelect ?? 0}, ${group.maxSelect ?? 1}, ${group.required ?? false}, ${group.allowQuantities ?? false}, ${index * 10})`);
  for (const [choiceIndex, choice] of group.choices.entries()) {
    choiceRows.push(`(${q(group.name)}, ${q(choice.name)}, ${choice.priceDeltaCents ?? 0}, ${choiceIndex * 10})`);
  }
}

const categoryRows: string[] = [];
const itemRows: string[] = [];
const variantRows: string[] = [];
const linkRows: string[] = [];
for (const [categoryIndex, category] of categories.entries()) {
  categoryRows.push(`(${q(category.name)}, ${q(category.description ?? "")}, ${(categoryIndex + 1) * 10})`);
  for (const [itemIndex, item] of category.items.entries()) {
    // An item with sizes prices from the chosen size; its base price is unused.
    const base = item.variants ? 0 : (item.priceCents ?? 0);
    itemRows.push(`(${q(category.name)}, ${q(item.name)}, ${q(item.description ?? "")}, ${base}, ${(itemIndex + 1) * 10})`);
    for (const [variantIndex, variant] of (item.variants ?? []).entries()) {
      variantRows.push(`(${q(category.name)}, ${q(item.name)}, ${q(variant.name)}, ${variant.priceCents}, ${variantIndex * 10})`);
    }
    for (const [linkIndex, key] of (item.groups ?? []).entries()) {
      const name = groupName.get(key);
      if (!name) throw new Error(`${item.name} refers to an unknown option group "${key}"`);
      linkRows.push(`(${q(category.name)}, ${q(item.name)}, ${q(name)}, ${linkIndex * 10})`);
    }
  }
}

console.log(`-- Wayne's Pizza menu, generated from scripts/menu-data.ts. Safe to run more than once:
-- every statement creates only what is missing and never changes a row that exists,
-- so a price corrected in Admin -> Menu survives a re-run. Nothing is ever deleted.
-- New items arrive hidden from customers (visible on the POS) so the menu can be
-- proofed against the paper menu before anyone can order from it.

insert into public.modifier_groups (name, customer_label, min_select, max_select, required, allow_quantities, sort_order)
select d.name, d.label, d.min_select, d.max_select, d.required, d.quantities, d.sort
from (values
  ${rows(groupRows)}
) as d(name, label, min_select, max_select, required, quantities, sort)
where not exists (select 1 from public.modifier_groups g where g.name = d.name and g.archived_at is null);

insert into public.modifier_choices (modifier_group_id, name, price_delta_cents, sort_order)
select g.id, d.choice, d.delta, d.sort
from (values
  ${rows(choiceRows)}
) as d(group_name, choice, delta, sort)
join public.modifier_groups g on g.name = d.group_name and g.archived_at is null
where not exists (select 1 from public.modifier_choices c where c.modifier_group_id = g.id and c.name = d.choice and c.archived_at is null);

insert into public.menu_categories (name, description, sort_order, customer_visible)
select d.name, d.description, d.sort, true
from (values
  ${rows(categoryRows)}
) as d(name, description, sort)
where not exists (select 1 from public.menu_categories c where c.name = d.name and c.archived_at is null);

insert into public.menu_items (category_id, name, description, base_price_cents, sort_order, customer_visible, pos_visible)
select c.id, d.item, d.description, d.price, d.sort, false, true
from (values
  ${rows(itemRows)}
) as d(category, item, description, price, sort)
join public.menu_categories c on c.name = d.category and c.archived_at is null
where not exists (select 1 from public.menu_items i where i.category_id = c.id and i.name = d.item and i.archived_at is null);

insert into public.menu_item_variants (menu_item_id, name, price_cents, sort_order)
select i.id, d.size, d.price, d.sort
from (values
  ${rows(variantRows)}
) as d(category, item, size, price, sort)
join public.menu_categories c on c.name = d.category and c.archived_at is null
join public.menu_items i on i.category_id = c.id and i.name = d.item and i.archived_at is null
where not exists (select 1 from public.menu_item_variants v where v.menu_item_id = i.id and v.name = d.size and v.archived_at is null);

insert into public.menu_item_modifier_groups (menu_item_id, modifier_group_id, sort_order)
select i.id, g.id, d.sort
from (values
  ${rows(linkRows)}
) as d(category, item, group_name, sort)
join public.menu_categories c on c.name = d.category and c.archived_at is null
join public.menu_items i on i.category_id = c.id and i.name = d.item and i.archived_at is null
join public.modifier_groups g on g.name = d.group_name and g.archived_at is null
on conflict do nothing;`);
