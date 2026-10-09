import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { saveCategoryOptionsAction } from "../../../actions";
import { CategoryOptionsForm, type OptionSection } from "./options-form";

export const metadata: Metadata = { title: "Category options" };
export const dynamic = "force-dynamic";

type ItemRow = { id: string; name: string };
type VariantRow = { id: string; menu_item_id: string; name: string };
type LinkRow = { menu_item_id: string; modifier_group_id: string; sort_order: number };
type GroupRow = { id: string; customer_label: string; min_select: number; max_select: number; required: boolean; allow_quantities: boolean };
type ChoiceRow = { id: string; modifier_group_id: string; name: string; price_delta_cents: number; sort_order: number };
type PriceRow = { modifier_choice_id: string; menu_item_variant_id: string; price_delta_cents: number };

/**
 * Every option section of a category on one page (owner request 2026-10-08):
 * change Cheese, Sauces, Vegetables… once and every item in the category
 * follows. What each item comes with is still set on the item itself.
 */
export default async function CategoryOptionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  await requirePermission("menu.manage", `/admin/menu/categories/${id}/options`);
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const { data: category } = await supabase.from("menu_categories").select("id,name").eq("id", id).maybeSingle();
  if (!category) notFound();

  const { data: itemData } = await supabase.from("menu_items").select("id,name").eq("category_id", id).is("archived_at", null).order("sort_order").order("name");
  const items = (itemData ?? []) as ItemRow[];
  const itemIds = items.map((item) => item.id);
  const [{ data: variantData }, { data: linkData }] = itemIds.length
    ? await Promise.all([
        supabase.from("menu_item_variants").select("id,menu_item_id,name").in("menu_item_id", itemIds).eq("active", true).is("archived_at", null).order("sort_order"),
        supabase.from("menu_item_modifier_groups").select("menu_item_id,modifier_group_id,sort_order").in("menu_item_id", itemIds).eq("active", true).order("sort_order"),
      ])
    : [{ data: [] }, { data: [] }];
  const variants = (variantData ?? []) as VariantRow[];
  const links = (linkData ?? []) as LinkRow[];
  const groupIds = [...new Set(links.map((link) => link.modifier_group_id))];
  const [{ data: groupData }, { data: choiceData }] = groupIds.length
    ? await Promise.all([
        supabase.from("modifier_groups").select("id,customer_label,min_select,max_select,required,allow_quantities").in("id", groupIds).eq("active", true).is("archived_at", null),
        supabase.from("modifier_choices").select("id,modifier_group_id,name,price_delta_cents,sort_order").in("modifier_group_id", groupIds).eq("active", true).is("archived_at", null).order("sort_order"),
      ])
    : [{ data: [] }, { data: [] }];
  const groups = new Map(((groupData ?? []) as GroupRow[]).map((group) => [group.id, group]));
  const choices = (choiceData ?? []) as ChoiceRow[];
  const choiceIds = choices.map((choice) => choice.id);
  const { data: priceData } = choiceIds.length
    ? await supabase.from("modifier_choice_variant_prices").select("modifier_choice_id,menu_item_variant_id,price_delta_cents").in("modifier_choice_id", choiceIds)
    : { data: [] };
  const prices = (priceData ?? []) as PriceRow[];

  const sizeNames = [...new Map(variants.map((variant) => [variant.name.trim().toLowerCase(), variant.name.trim()])).values()];
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const linksByGroup = new Map<string, LinkRow[]>();
  for (const link of links) linksByGroup.set(link.modifier_group_id, [...(linksByGroup.get(link.modifier_group_id) ?? []), link]);

  // One section per label, in the order items show them.
  const sections = new Map<string, OptionSection & { order: number; mins: number[]; maxes: number[]; requireds: boolean[]; quantities: boolean[]; itemSet: Set<string> }>();
  for (const link of links) {
    const group = groups.get(link.modifier_group_id);
    if (!group) continue;
    const key = group.customer_label.trim().toLowerCase();
    let section = sections.get(key);
    if (!section) {
      section = { key: group.customer_label.trim(), label: group.customer_label.trim(), min_select: 0, max_select: 1, required: false, allow_quantities: false, item_count: 0, choices: [], order: link.sort_order, mins: [], maxes: [], requireds: [], quantities: [], itemSet: new Set() };
      sections.set(key, section);
    }
    section.order = Math.min(section.order, link.sort_order);
    section.itemSet.add(link.menu_item_id);
    section.mins.push(group.min_select); section.maxes.push(group.max_select);
    section.requireds.push(group.required); section.quantities.push(group.allow_quantities);
  }
  for (const section of sections.values()) {
    const sectionGroupIds = new Set(links.filter((link) => groups.get(link.modifier_group_id)?.customer_label.trim().toLowerCase() === section.key.toLowerCase()).map((link) => link.modifier_group_id));
    const byName = new Map<string, OptionSection["choices"][number] & { itemSet: Set<string>; priceSet: Set<number>; sizeSets: Map<string, Set<number>>; sort: number }>();
    for (const choice of choices) {
      if (!sectionGroupIds.has(choice.modifier_group_id)) continue;
      const nameKey = choice.name.trim().toLowerCase();
      let entry = byName.get(nameKey);
      if (!entry) {
        entry = { key: choice.name.trim(), name: choice.name.trim(), price_cents: null, size_prices: {}, item_count: 0, itemSet: new Set(), priceSet: new Set(), sizeSets: new Map(), sort: choice.sort_order };
        byName.set(nameKey, entry);
      }
      entry.sort = Math.min(entry.sort, choice.sort_order);
      entry.priceSet.add(choice.price_delta_cents);
      for (const link of linksByGroup.get(choice.modifier_group_id) ?? []) entry.itemSet.add(link.menu_item_id);
      for (const row of prices) {
        if (row.modifier_choice_id !== choice.id) continue;
        const variant = variantById.get(row.menu_item_variant_id);
        if (!variant) continue;
        const size = variant.name.trim();
        entry.sizeSets.set(size.toLowerCase(), (entry.sizeSets.get(size.toLowerCase()) ?? new Set()).add(row.price_delta_cents));
      }
    }
    section.choices = [...byName.values()].sort((a, b) => a.sort - b.sort).map((entry) => ({
      key: entry.key,
      name: entry.name,
      price_cents: entry.priceSet.size === 1 ? [...entry.priceSet][0] : null,
      size_prices: Object.fromEntries(sizeNames.map((size) => {
        const set = entry.sizeSets.get(size.toLowerCase());
        return [size, set && set.size === 1 ? [...set][0] : set ? "varies" : null];
      })),
      item_count: entry.itemSet.size,
    }));
    section.item_count = section.itemSet.size;
    section.min_select = Math.min(...section.mins);
    section.max_select = Math.max(...section.maxes);
    section.required = section.requireds.every(Boolean);
    section.allow_quantities = section.quantities.some(Boolean);
  }
  const ordered: OptionSection[] = [...sections.values()].sort((a, b) => a.order - b.order).map((section) => ({
    key: section.key, label: section.label, min_select: section.min_select, max_select: section.max_select,
    required: section.required, allow_quantities: section.allow_quantities, item_count: section.item_count, choices: section.choices,
  }));

  const [updated, added, removed] = (query.saved ?? "").split("-").map(Number);
  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <Link className="font-bold text-wayne-red" href="/admin/menu">← Menu</Link>
      <h1 className="mt-4 text-4xl font-black">{category.name} — options</h1>
      <p className="mt-2 max-w-3xl text-wayne-muted">
        Changes here apply to every item in {category.name} ({items.length} item{items.length === 1 ? "" : "s"}).
        What each item <em>comes with</em> is still set on the item itself.
      </p>
      {query.saved ? (
        <div className="mt-5 rounded-xl border border-wayne-ok/30 bg-wayne-ok-soft p-4 font-semibold text-wayne-ok">
          Saved for all of {category.name}.{Number.isFinite(added) && added ? ` ${added} option${added === 1 ? "" : "s"} added across items.` : ""}{Number.isFinite(removed) && removed ? ` ${removed} removed.` : ""}{Number.isFinite(updated) && updated ? ` ${updated} updated.` : ""}
        </div>
      ) : null}
      {query.error ? <div className="mt-5 rounded-xl border border-wayne-alert/30 bg-wayne-alert-soft p-4 font-semibold text-wayne-alert">{query.error}</div> : null}
      {ordered.length ? (
        <CategoryOptionsForm action={saveCategoryOptionsAction.bind(null, id)} itemCount={items.length} key={query.saved ?? "form"} sections={ordered} sizeNames={sizeNames} />
      ) : (
        <p className="mt-8 rounded-xl border border-wayne-border bg-white p-6 text-wayne-muted">
          No item in {category.name} has options yet. Add an option section to one item, then come back here to give it to the rest.
        </p>
      )}
    </main>
  );
}
