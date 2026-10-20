import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/access";
import { getWorkspaceStoreSettings } from "@/lib/content/queries";
import { formatCents } from "@/lib/menu/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { removeSpecialAction, saveSpecialAction } from "../actions";

export const metadata: Metadata = { title: "Specials" };
export const dynamic = "force-dynamic";

type Item = {
  id: string;
  category_id: string;
  name: string;
  base_price_cents: number;
  customer_visible: boolean;
  sold_out: boolean;
  special: boolean;
  special_note: string;
  special_online: boolean;
  special_ends_on: string | null;
};
type Category = { id: string; name: string };

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
  const [{ data: itemData }, { data: categoryData }, params, settings] = await Promise.all([
    supabase.from("menu_items")
      .select("id,category_id,name,base_price_cents,customer_visible,sold_out,special,special_note,special_online,special_ends_on")
      .is("archived_at", null).order("sort_order").order("name"),
    supabase.from("menu_categories").select("id,name").is("archived_at", null).order("sort_order").order("name"),
    searchParams,
    getWorkspaceStoreSettings(),
  ]);
  const items = (itemData ?? []) as Item[];
  const categories = (categoryData ?? []) as Category[];
  const categoryName = new Map(categories.map((category) => [category.id, category.name]));
  const specials = items.filter((item) => item.special);
  const adding = items.find((item) => item.id === params.add && !item.special) ?? null;
  // The store's own date (an end date means "through that day" where the store is).
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timezone || "America/New_York" }).format(new Date());

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red"><Link className="hover:underline" href="/admin/menu">Menu</Link> / Specials</p>
      <h1 className="mt-3 text-4xl font-black">⭐ Specials</h1>
      <p className="mt-3 max-w-3xl text-wayne-muted">
        Specials are for the POS only: they sit under the <strong>⭐ Specials</strong> button for walk-in, pickup and phone pickup orders — never in the regular menu,
        never on deliveries, never online. Making an item a special makes <strong>its own copy</strong> with its own price, so the regular item doesn&apos;t change.
        After adding one, set its special price with <strong>Edit price &amp; options</strong>. For a brand-new deal (e.g. “2 Large Cheese + 2-Liter $24.99”), first
        {" "}<Link className="font-bold underline" href="/admin/menu/new">create it as a menu item</Link> (untick “show online”), then add it here.
      </p>
      {params.saved ? <p className="mt-5 rounded-xl border border-wayne-ok/30 bg-wayne-ok-soft p-4 font-semibold text-wayne-ok">{params.saved}</p> : null}
      {params.error ? <p className="mt-5 rounded-xl border border-wayne-alert/30 bg-wayne-alert-soft p-4 font-semibold text-wayne-alert">{params.error}</p> : null}

      <Card className="mt-8 p-6">
        <h2 className="text-2xl font-black">{adding ? `Make “${adding.name}” a special` : "Add a special"}</h2>
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
                    <p className="text-xs font-black uppercase tracking-[0.14em] text-wayne-muted">{categoryName.get(item.category_id) ?? "Menu"}</p>
                    <h3 className="text-xl font-black">{item.name} <span className="font-bold text-wayne-red">{formatCents(item.base_price_cents)}</span></h3>
                    <p className="mt-1 text-sm font-bold">
                      {ended ? <span className="text-wayne-alert">Ended {item.special_ends_on} — not on the POS</span> : item.special_ends_on ? `Runs through ${item.special_ends_on}` : "No end date"}
                      {" · "}POS Specials only · walk-in &amp; pickup
                      {item.sold_out ? " · Sold out" : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="secondary"><Link href={`/admin/menu/items/${item.id}`}>Edit price &amp; options</Link></Button>
                    <form action={removeSpecialAction}><input name="id" type="hidden" value={item.id} /><Button type="submit" variant="danger">Stop the special</Button></form>
                  </div>
                </div>
                <form action={saveSpecialAction} className="mt-4 grid gap-3 border-t border-wayne-border pt-4 md:grid-cols-[1fr_12rem_auto] md:items-end">
                  <input name="id" type="hidden" value={item.id} />
                  <Field defaultValue={item.special_note} label="Headline (shown on the POS button)" name="special_note" />
                  <label className="grid gap-1.5 text-sm font-semibold">Ends on (optional)
                    <input className="min-h-11 rounded-lg border border-wayne-border px-3 font-normal" defaultValue={item.special_ends_on ?? ""} name="special_ends_on" type="date" />
                  </label>
                  <Button type="submit">Save</Button>
                </form>
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

function Field({ label, name, defaultValue }: { label: string; name: string; defaultValue: string }) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold">{label}
      <input className="min-h-11 rounded-lg border border-wayne-border px-3 font-normal" defaultValue={defaultValue} maxLength={200} name={name} />
    </label>
  );
}
