import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/access";
import { getWorkspaceStoreSettings } from "@/lib/content/queries";
import { bundleComponentLabel, type BundleComponent } from "@/lib/menu/bundle-specials";
import { formatCents } from "@/lib/menu/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { removeSpecialAction, saveSpecialAction, saveSpecialPricesAction } from "../actions";
import { BundleForm, type BundleOptions } from "./bundle-form";

export const metadata: Metadata = { title: "Specials" };
export const dynamic = "force-dynamic";

type Item = {
  id: string;
  category_id: string;
  name: string;
  base_price_cents: number;
  pos_visible: boolean;
  sold_out: boolean;
  special: boolean;
  special_note: string;
  special_ends_on: string | null;
  special_source_item_id: string | null;
  special_bundle: BundleComponent[] | null;
  menu_revision: number;
  menu_item_variants: (Variant & { active: boolean; archived_at: string | null })[];
};
type Category = { id: string; name: string };
type Variant = { id: string; name: string; price_cents: number; sort_order: number };

/**
 * Specials (owner, 2026-10-19, evening): "the special section should only be
 * for specials … only if you click it, it's not for the whole menu or online",
 * for walk-ins, pickups and phone pickups.
 *
 * Making an item a special makes its own copy (sizes, options, what it comes
 * with) with its own price.  The copy shows only under the POS ⭐ Specials
 * button, on walk-in and pickup orders; the regular item, the online menu and
 * the website never change.
 */
export default async function SpecialsPage({ searchParams }: { searchParams: Promise<{ add?: string; saved?: string; error?: string }> }) {
  await requirePermission("menu.manage", "/admin/menu/specials");
  const supabase = await createServerSupabaseClient();
  const [{ data: itemData, error: itemError }, { data: categoryData, error: categoryError }, params, settings] = await Promise.all([
    supabase.from("menu_items")
      .select("id,category_id,name,base_price_cents,pos_visible,sold_out,special,special_note,special_ends_on,special_source_item_id,special_bundle,menu_revision,menu_item_variants(id,name,price_cents,sort_order,active,archived_at)")
      .is("archived_at", null).order("sort_order").order("name"),
    supabase.from("menu_categories").select("id,name").is("archived_at", null).order("sort_order").order("name"),
    searchParams,
    getWorkspaceStoreSettings(),
  ]);
  if (itemError || categoryError) throw new Error("Could not load the menu for Specials.");
  const items = (itemData ?? []) as Item[];
  const categories = (categoryData ?? []) as Category[];
  const categoryName = new Map(categories.map((category) => [category.id, category.name]));
  const specials = items.filter((item) => item.special);
  // Each special beside the regular item it was made from (same name, same category), size by size,
  // so the special price and the regular price can't be mixed up (owner, 2026-10-20).
  const regularFor = new Map(specials.map((special) => [special.id, items.find((item) => !item.special && (special.special_source_item_id ? item.id === special.special_source_item_id : item.category_id === special.category_id && item.name === special.name)) ?? null]));
  const variants = new Map(items.map((item) => [item.id, item.menu_item_variants
    .filter((variant) => variant.active && variant.archived_at === null)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))]));
  const options: BundleOptions = categories.flatMap((category) => {
    const choices = items.filter((item) => !item.special && item.pos_visible && item.category_id === category.id)
      .flatMap((item) => {
        const sizes = variants.get(item.id) ?? [];
        return sizes.length
          ? sizes.map((size) => ({ value: `${item.id}:${size.id}`, name: `${item.name} · ${size.name}` }))
          : [{ value: `${item.id}:`, name: item.name }];
      });
    return choices.length ? [{ id: category.id, category: category.name, choices }] : [];
  });
  const adding = items.find((item) => item.id === params.add && !item.special) ?? null;
  // The store's own date (an end date means "through that day" where the store is).
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone || "America/New_York" }).format(new Date());

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red"><Link className="hover:underline" href="/admin/menu">Menu</Link> / Specials</p>
      <h1 className="mt-3 text-4xl font-black">⭐ Specials</h1>
      <p className="mt-3 max-w-3xl text-wayne-muted">
        Specials are available under <strong>⭐ Specials</strong> on the POS for walk-in and pickup orders, including phone pickups.
      </p>
      {params.saved ? <p className="mt-5 rounded-xl border border-wayne-ok/30 bg-wayne-ok-soft p-4 font-semibold text-wayne-ok">{params.saved}</p> : null}
      {params.error ? <p className="mt-5 rounded-xl border border-wayne-alert/30 bg-wayne-alert-soft p-4 font-semibold text-wayne-alert">{params.error}</p> : null}

      <Card className="mt-8 p-6">
        <h2 className="text-2xl font-black">Create a bundle special</h2>
        <p className="mt-2 text-sm text-wayne-muted">Choose the items and sizes included in one fixed price. For two of the same item and size, set the quantity to 2.</p>
        <BundleForm key={params.saved} options={options} />
      </Card>

      <Card className="mt-8 p-6">
        <h2 className="text-2xl font-black">{adding ? `Make “${adding.name}” a special` : "Add a single-item special"}</h2>
        <SpecialForm categories={categories} items={items.filter((item) => !item.special)} selected={adding} today={today} />
      </Card>

      <h2 className="mt-10 text-2xl font-black">Running now ({specials.length})</h2>
      {specials.length ? (
        <div className="mt-4 grid gap-4">
          {specials.map((item) => {
            const ended = item.special_ends_on !== null && item.special_ends_on < today;
            return (
              <Card className={`p-5 ${ended ? "opacity-70" : ""}`} key={item.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.14em] text-wayne-muted">{item.special_bundle ? "Bundle special" : categoryName.get(item.category_id) ?? "Menu"}</p>
                    <h3 className="text-xl font-black">⭐ {item.name} <span className="rounded-lg bg-wayne-red px-2 py-0.5 text-sm font-black uppercase tracking-wide text-white">Special</span></h3>
                    <p className="mt-1 text-sm font-bold">
                      {ended ? <span className="text-wayne-alert">Ended {item.special_ends_on} — not on the POS</span> : item.special_ends_on ? `Runs through ${item.special_ends_on}` : "No end date"}
                      {" · "}POS Specials only · walk-in &amp; pickup
                      {item.sold_out ? " · Sold out" : ""}
                    </p>
                    {item.special_bundle ? <p className="mt-1 text-sm"><strong>{formatCents(item.base_price_cents)}</strong> · {item.special_bundle.map(bundleComponentLabel).join(" · ")}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!item.special_bundle ? <Button asChild variant="secondary"><Link href={`/admin/menu/items/${item.id}`}>Edit the special&apos;s options</Link></Button> : null}
                    <form action={removeSpecialAction}><input name="id" type="hidden" value={item.id} /><Button type="submit" variant="danger">Stop the special</Button></form>
                  </div>
                </div>
                {item.special_bundle ? <details className="mt-4 border-t border-wayne-border pt-4">
                  <summary className="cursor-pointer font-bold">Edit bundle</summary>
                  <BundleForm key={item.menu_revision} options={options} initial={{
                    id: item.id, revision: item.menu_revision, name: item.name, price: (item.base_price_cents / 100).toFixed(2),
                    endsOn: item.special_ends_on, components: item.special_bundle,
                  }} />
                </details> : <>
                  <SpecialPrices regular={regularFor.get(item.id) ?? null} special={item} variants={variants} />
                  <form action={saveSpecialAction} className="mt-4 grid gap-3 border-t border-wayne-border pt-4 md:grid-cols-[1fr_12rem_auto] md:items-end">
                    <input name="id" type="hidden" value={item.id} />
                    <Field defaultValue={item.special_note} label="Headline (shown on the POS button)" name="special_note" />
                    <label className="grid gap-1.5 text-sm font-semibold">Ends on (optional)
                      <input className="min-h-11 rounded-lg border border-wayne-border px-3 font-normal" defaultValue={item.special_ends_on ?? ""} name="special_ends_on" type="date" />
                    </label>
                    <Button type="submit">Save</Button>
                  </form>
                </>}
              </Card>
            );
          })}
        </div>
      ) : <p className="mt-4 rounded-2xl border-2 border-dashed border-wayne-border p-6 text-wayne-muted">No specials yet. Add one above, or use <strong>☆ Make special</strong> next to any item in Menu.</p>}
    </main>
  );
}

function SpecialForm({ items, categories, selected, today }: { items: Item[]; categories: Category[]; selected: Item | null; today: string }) {
  return (
    <form action={saveSpecialAction} className="mt-4 grid gap-4">
      {selected ? <input name="id" type="hidden" value={selected.id} /> : (
        <label className="grid gap-1.5 text-sm font-semibold">Menu item
          <select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3 font-normal" defaultValue="" name="id" required>
            <option disabled value="">Choose an item…</option>
            {categories.map((category) => {
              const inCategory = items.filter((item) => item.category_id === category.id);
              return inCategory.length ? (
                <optgroup key={category.id} label={category.name}>
                  {inCategory.map((item) => <option key={item.id} value={item.id}>{item.name} — {formatCents(item.base_price_cents)}</option>)}
                </optgroup>
              ) : null;
            })}
          </select>
        </label>
      )}
      <div className="grid gap-4 md:grid-cols-[1fr_12rem]">
        <Field defaultValue="" label="Headline (optional) — e.g. “Tuesday only” or “Feeds 4”" name="special_note" />
        <label className="grid gap-1.5 text-sm font-semibold">Ends on (optional)
          <input className="min-h-11 rounded-lg border border-wayne-border px-3 font-normal" min={today} name="special_ends_on" type="date" />
        </label>
      </div>
      <p className="text-sm text-wayne-muted">This makes a separate copy of the item for the POS Specials button only. The regular item stays exactly as it is.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit">⭐ Make it a special</Button>
        {selected ? <Button asChild variant="secondary"><Link href="/admin/menu/specials">Choose a different item</Link></Button> : null}
      </div>
    </form>
  );
}

function SpecialPrices({ special, regular, variants }: { special: Item; regular: Item | null; variants: Map<string, Variant[]> }) {
  const sizes = variants.get(special.id) ?? [];
  const regularPrice = new Map((regular ? variants.get(regular.id) ?? [] : []).map((variant) => [variant.name, variant.price_cents]));
  if (!sizes.length) return null;
  return (
    <form action={saveSpecialPricesAction} className="mt-4 border-t border-wayne-border pt-4">
      <input name="id" type="hidden" value={special.id} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left">
          <thead><tr className="text-xs font-black uppercase tracking-[0.12em] text-wayne-muted"><th className="py-1 pr-3">Size</th><th className="py-1 pr-3">Regular price{regular ? "" : " (no regular item)"}</th><th className="py-1">⭐ Special price</th></tr></thead>
          <tbody>
            {sizes.map((size) => {
              const normal = regularPrice.get(size.name);
              return (
                <tr className="border-t border-wayne-border" key={size.id}>
                  <td className="py-2 pr-3 font-black">{size.name}</td>
                  <td className="py-2 pr-3 font-bold text-wayne-muted">{normal === undefined ? "—" : formatCents(normal)}</td>
                  <td className="py-2">
                    <label className="flex items-center gap-1 font-black text-wayne-red">$
                      <input aria-label={`${size.name} special price`} className="min-h-11 w-28 rounded-lg border-2 border-wayne-red/40 px-3 font-black text-wayne-ink" defaultValue={(size.price_cents / 100).toFixed(2)} inputMode="decimal" name={`price_${size.id}`} pattern="[0-9]+(\.[0-9]{1,2})?" required />
                      {normal !== undefined && size.price_cents < normal ? <span className="ml-2 text-xs font-bold text-wayne-ok">saves {formatCents(normal - size.price_cents)}</span> : null}
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit">Save special prices</Button>
        <p className="text-sm text-wayne-muted">Only the special changes. The regular {special.name} keeps its price on the POS and online.</p>
      </div>
    </form>
  );
}

function Field({ label, name, defaultValue }: { label: string; name: string; defaultValue: string }) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold">{label}
      <input className="min-h-11 rounded-lg border border-wayne-border px-3 font-normal" defaultValue={defaultValue} maxLength={200} name={name} />
    </label>
  );
}
