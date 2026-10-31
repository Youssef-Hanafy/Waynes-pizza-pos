import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth/access";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { savePosAutoAddAction, updateMenuItemAction } from "../../actions";
import { MenuItemForm, type MenuItemInitial } from "../../menu-item-form";

export const metadata: Metadata = { title: "Edit menu item" };
type ItemRow = { menu_revision: number; id: string; category_id: string; name: string; description: string; image_alt: string; base_price_cents: number; tax_category: string; included_count_label: string; sold_out: boolean; customer_visible: boolean; pos_visible: boolean; featured: boolean; kitchen_route: string | null; available_days: number[]; available_start: string | null; available_end: string | null; sort_order: number; special?: boolean };
type VariantRow = { id: string; name: string; price_cents: number; sku: string | null };
type LinkRow = { modifier_group_id: string; sort_order: number };
type GroupRow = { id: string; name: string; customer_label: string; min_select: number; max_select: number; required: boolean; allow_quantities: boolean; allow_halves: boolean };
type ChoiceRow = { id: string; modifier_group_id: string; name: string; price_delta_cents: number; default_selected: boolean; sort_order: number };
type VariantPriceRow = { modifier_choice_id: string; menu_item_variant_id: string; price_delta_cents: number };

export default async function EditMenuItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; error?: string }> }) {
  const { id } = await params; const notice = await searchParams; await requirePermission("menu.manage", `/admin/menu/items/${id}`); const supabase = await createServerSupabaseClient();
  // Read the revision before child queries, then recheck it after all reads.
  // Parallel item/child requests could otherwise pair a new revision with old
  // variants and allow the next save to overwrite a newer register's changes.
  const { data: itemData, error: itemError } = await supabase.from("menu_items").select("menu_revision,id,category_id,name,description,image_alt,base_price_cents,tax_category,included_count_label,sold_out,customer_visible,pos_visible,featured,kitchen_route,available_days,available_start,available_end,sort_order,pos_auto_add,special").eq("id", id).maybeSingle();
  if (itemError) throw new Error("Could not load the complete menu editor. Reload before editing.");
  if (!itemData) notFound();
  const item = itemData as ItemRow;
  const [{ data: categoryData, error: categoryError }, { data: variantData, error: variantError }, { data: linkData, error: linkError }] = await Promise.all([
    supabase.from("menu_categories").select("id,name").is("archived_at", null).order("sort_order"),
    supabase.from("menu_item_variants").select("id,name,price_cents,sku").eq("menu_item_id", id).eq("active", true).is("archived_at", null).order("sort_order"),
    supabase.from("menu_item_modifier_groups").select("modifier_group_id,sort_order").eq("menu_item_id", id).eq("active", true).order("sort_order"),
  ]);
  if (categoryError || variantError || linkError) throw new Error("Could not load the complete menu editor. Reload before editing.");
  const links = (linkData ?? []) as LinkRow[];
  const groupIds = links.map((link) => link.modifier_group_id);
  const [{ data: groupData, error: groupError }, { data: choiceData, error: choiceError }] = groupIds.length ? await Promise.all([supabase.from("modifier_groups").select("id,name,customer_label,min_select,max_select,required,allow_quantities,allow_halves").in("id", groupIds).eq("active", true), supabase.from("modifier_choices").select("id,modifier_group_id,name,price_delta_cents,default_selected,sort_order").in("modifier_group_id", groupIds).eq("active", true).is("archived_at", null).order("sort_order")]) : [{ data: [], error: null }, { data: [], error: null }];
  if (groupError || choiceError) throw new Error("Could not load modifiers. Reload before editing.");
  const groups = (groupData ?? []) as GroupRow[];
  // "Comes with" for this item: either the option's own flag, or -- for option
  // groups shared across items -- a per-item row.  Saving copies it onto this
  // item's own options, so the checkbox below always shows the live answer.
  const { data: includedData, error: includedError } = await supabase.from("menu_item_included_choices").select("modifier_choice_id").eq("menu_item_id", id);
  if (includedError) throw new Error("Could not load included choices. Reload before editing.");
  const includedIds = new Set(((includedData ?? []) as { modifier_choice_id: string }[]).map((row) => row.modifier_choice_id));
  const choices = ((choiceData ?? []) as ChoiceRow[]).map((choice) => ({ ...choice, default_selected: choice.default_selected || includedIds.has(choice.id) }));
  const variantRows = (variantData ?? []) as VariantRow[];
  const variantNameById = new Map(variantRows.map((variant) => [variant.id, variant.name]));
  const choiceIds = choices.map((choice) => choice.id);
  const { data: variantPriceData, error: variantPriceError } = choiceIds.length
    ? await supabase.from("modifier_choice_variant_prices").select("modifier_choice_id,menu_item_variant_id,price_delta_cents").in("modifier_choice_id", choiceIds)
    : { data: [], error: null };
  if (variantPriceError) throw new Error("Could not load size price overrides. Reload before editing.");
  const { data: latestItem, error: revisionError } = await supabase.from("menu_items").select("menu_revision").eq("id", id).maybeSingle();
  if (revisionError || !latestItem || latestItem.menu_revision !== item.menu_revision) {
    return <main className="mx-auto max-w-5xl px-5 py-10"><h1 className="text-2xl font-black">Menu changed</h1><p>This menu item changed while it was loading. Reload before editing.</p><Link className="font-bold text-wayne-red underline" href={`/admin/menu/items/${id}`}>Load the latest menu item</Link></main>;
  }
  const variantPrices = (variantPriceData ?? []) as VariantPriceRow[];
  const initial: MenuItemInitial = { ...item, image_alt: item.image_alt, base_price: (item.base_price_cents / 100).toFixed(2), kitchen_route: item.kitchen_route ?? "", available_start: item.available_start?.slice(0,5) ?? "", available_end: item.available_end?.slice(0,5) ?? "", variants: variantRows.map((variant) => ({ id: variant.id, name: variant.name, price: (variant.price_cents / 100).toFixed(2), sku: variant.sku ?? "" })), modifier_groups: links.map((link) => groups.find((group) => group.id === link.modifier_group_id)).filter((group): group is GroupRow => Boolean(group)).map((group) => ({ id: group.id, name: group.name, customer_label: group.customer_label, min_select: group.min_select, max_select: group.max_select, required: group.required, allow_quantities: group.allow_quantities, allow_halves: Boolean(group.allow_halves), choices: choices.filter((choice) => choice.modifier_group_id === group.id).map((choice) => ({ name: choice.name, price: (choice.price_delta_cents / 100).toFixed(2), default_selected: choice.default_selected, variant_prices: Object.fromEntries(variantPrices.filter((row) => row.modifier_choice_id === choice.id).map((row) => [variantNameById.get(row.menu_item_variant_id) ?? "", (row.price_delta_cents / 100).toFixed(2)]).filter(([name]) => name)) })) })) };
  return <main className="mx-auto max-w-5xl px-5 py-10"><Link className="font-bold text-wayne-red" href="/admin/menu">← Menu</Link><h1 className="mt-4 text-4xl font-black">Edit {item.special ? "⭐ SPECIAL " : ""}{item.name}</h1>{item.special ? <p className="mt-3 rounded-xl border-2 border-wayne-red bg-wayne-red-soft p-4 font-bold text-wayne-red">This is the <strong>special</strong> copy of {item.name} — it is only under ⭐ Specials on the POS. Its price is set in <Link className="underline" href="/admin/menu/specials">⭐ Specials</Link>, right beside the regular price. The regular {item.name} is changed in <Link className="underline" href="/admin/menu">Menu</Link>, not here.</p> : null}<p className="mt-2 text-wayne-muted">Use Save prices only to keep sizes and modifier settings intact. Save menu item also saves changes to the item details, sizes and modifiers.</p><p className="mt-2 rounded-xl border border-wayne-border bg-wayne-cream p-3 text-sm font-semibold">Changing an option for every item in this category? Use <Link className="font-black text-wayne-red underline" href={`/admin/menu/categories/${item.category_id}/options`}>Edit options for all items</Link> instead — this page is for this one item (and what it comes with).</p>{notice.error ? <p className="mt-4 rounded-xl border border-wayne-alert/30 bg-wayne-alert-soft p-3 font-semibold text-wayne-alert">{notice.error}</p> : null}<form action={savePosAutoAddAction} className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-wayne-border bg-white p-3 text-sm"><input name="id" type="hidden" value={item.id} /><label className="flex min-h-11 flex-1 items-center gap-2 font-semibold"><input className="size-5 accent-wayne-red" defaultChecked={Boolean((itemData as { pos_auto_add?: boolean }).pos_auto_add)} name="pos_auto_add" type="checkbox" />POS: add to the ticket by itself once its first option is picked (e.g. a One Topping Pizza once the topping is chosen)</label><button className="min-h-11 rounded-lg border border-wayne-border px-4 font-bold" type="submit">Save</button></form><div className="mt-8"><MenuItemForm key={`${id}:${item.menu_revision}`} savedMessage={notice.saved} action={updateMenuItemAction.bind(null, id)} categories={(categoryData ?? []) as { id: string; name: string }[]} initial={initial} submitLabel="Save menu item" /></div></main>;
}
