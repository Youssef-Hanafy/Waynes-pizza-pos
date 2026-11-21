"use client";
import { useState, useTransition } from "react";
import type { SharedSauce } from "@/lib/menu/shared-sauces";
import { formatCents, parseMoneyToCents } from "@/lib/menu/schemas";
import { Button } from "@/components/ui/button";

export function SaucePricesForm({ sauces, action }: { sauces: SharedSauce[]; action: (data: FormData) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const edits = sauces.flatMap(sauce => {
    const raw = values[sauce.key];
    return raw === undefined || !raw.trim() ? [] : [{ key: sauce.key, price_cents: parseMoneyToCents(raw) }];
  });
  const invalid = edits.some(edit => edit.price_cents === null || edit.price_cents > 100_000);
  return <form className="mt-6 grid gap-4" onSubmit={event => {
    event.preventDefault();
    if (invalid || !edits.length) return;
    const data = new FormData(); data.set("prices", JSON.stringify(edits));
    startTransition(async () => { await action(data); });
  }}>
    {sauces.map(sauce => <label className="grid gap-3 rounded-xl border border-wayne-border bg-white p-4 sm:grid-cols-[minmax(0,1fr)_10rem]" key={sauce.key}>
      <span><strong className="block text-lg">{sauce.name}</strong><span className="text-sm text-wayne-muted">On {sauce.item_count} items · {sauce.price_cents !== null ? `Shared price ${formatCents(sauce.price_cents)}` : sauce.min_cents === sauce.max_cents ? `Current price ${formatCents(sauce.min_cents)}` : `Prices vary: ${formatCents(sauce.min_cents)}–${formatCents(sauce.max_cents)}`}</span></span>
      <span className="grid gap-1 text-sm font-bold">Price per extra portion ($)<input aria-label={`${sauce.name} shared price`} className="min-h-11 min-w-0 rounded-lg border border-wayne-border px-3" inputMode="decimal" placeholder={((sauce.price_cents ?? sauce.min_cents) / 100).toFixed(2)} value={values[sauce.key] ?? ""} onChange={event => setValues({ ...values, [sauce.key]: event.target.value })} /></span>
    </label>)}
    {invalid ? <p role="alert" className="font-bold text-wayne-alert">Enter prices from $0.00 to $1,000.00.</p> : null}
    <Button className="justify-self-end" type="submit" disabled={pending || invalid || !edits.length}>{pending ? "Saving…" : "Save shared sauce prices"}</Button>
  </form>;
}
