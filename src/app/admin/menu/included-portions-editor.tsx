"use client";
import type { SizeRule } from "@/lib/orders/cart";

export function IncludedPortionsEditor({ rules, sizes, onChange, sharedPrices }: { rules: SizeRule[]; sizes: { key: string; name: string }[]; onChange: (rules: SizeRule[]) => void; sharedPrices: boolean }) {
  return <div className="grid gap-3 rounded-xl border border-wayne-ok/40 bg-white p-4">
    <h3 className="font-black">Free portions by size · this item only</h3>
    <p className="text-sm text-wayne-muted">Choose what is selected by default below. These quantities control how many portions are free, including repeats or a mix of choices. Any more are charged. A size row overrides the all-sizes row; blank uses the all-sizes rule.</p>
    {[{ key: "", name: "All sizes / fallback" }, ...sizes].map(size => {
      const rule = rules.find(row => row.variant_name.trim().toLowerCase() === size.key.trim().toLowerCase());
      function patch(change: Partial<SizeRule>) {
        const rest = rules.filter(row => row !== rule);
        onChange([...rest, { variant_name: size.key, included_count: 0, max_portions: null, extra_each_cents: null, ...rule, ...change }]);
      }
      return <div className="grid gap-2 rounded-lg border border-wayne-border p-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem]" key={size.key}>
        <span className="self-center font-bold">{size.name}</span>
        <label className="grid gap-1 text-sm font-bold">Free portions<input aria-label={`${size.name} free portions`} className="min-h-11 w-full rounded-lg border border-wayne-border px-2" type="number" min={0} max={20} value={rule?.included_count ?? ""} placeholder={size.key ? "Use fallback" : "Per choice"} onChange={event => {
          if (!event.target.value) onChange(rules.filter(row => row !== rule));
          else patch({ included_count: Number(event.target.value) });
        }} /></label>
        <label className="grid gap-1 text-sm font-bold">Most allowed<input aria-label={`${size.name} maximum portions`} className="min-h-11 w-full rounded-lg border border-wayne-border px-2" type="number" min={Math.max(1, rule?.included_count ?? 0)} max={20} disabled={!rule} value={rule?.max_portions ?? ""} placeholder="20" onChange={event => patch({ max_portions: event.target.value ? Number(event.target.value) : null })} /></label>
        {rule && !sharedPrices ? <label className="grid gap-1 text-sm sm:col-span-3">Extra portion price ($, blank uses each choice’s price)<input className="min-h-11 max-w-48 rounded-lg border border-wayne-border px-2" type="number" min={0} step="0.01" value={rule.extra_each_cents === null ? "" : rule.extra_each_cents / 100} onChange={event => patch({ extra_each_cents: event.target.value ? Math.round(Number(event.target.value) * 100) : null })} /></label> : null}
      </div>;
    })}
    {sharedPrices ? <p className="text-sm">Extra portions use <a className="font-bold text-wayne-red underline" href="/admin/menu/sauces">shared sauce and dressing prices</a>. The included quantity stays specific to this item and size.</p> : null}
  </div>;
}
