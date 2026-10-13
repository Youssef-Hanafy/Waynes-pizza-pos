"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/menu/schemas";
import { OPEN_ITEM_ID, type CartLine } from "@/lib/orders/schemas";
import { uuid } from "@/lib/uuid";

const QUICK_NAMES = ["Open food", "Extra", "Misc", "Side", "Drink"];

/** Dollars typed by the cashier ("4", "4.5", "$4.50") as cents, or null. */
export function dollarsToCents(text: string): number | null {
  const clean = text.replace(/[$,\s]/g, "");
  if (!/^\d{0,4}(\.\d{0,2})?$/.test(clean) || clean === "" || clean === ".") return null;
  return Math.round(Number(clean) * 100);
}

/**
 * Open item (owner, 2026-10-13): anything not on the menu — an extra charge,
 * a special request, a misc item — with a name and a price typed right here.
 * It prints on the kitchen ticket and the receipt like any other line.
 */
export function OpenItemDialog({ initialLine, onAdd, onClose }: { initialLine: CartLine | null; onAdd: (line: CartLine) => void; onClose: () => void }) {
  const [name, setName] = useState(initialLine?.open_item?.name ?? "Open food");
  const [price, setPrice] = useState(initialLine?.open_item ? (initialLine.open_item.price_cents / 100).toFixed(2) : "");
  const [quantity, setQuantity] = useState(initialLine?.quantity ?? 1);
  const [note, setNote] = useState(initialLine?.special_instructions ?? "");
  const [error, setError] = useState("");
  const cents = dollarsToCents(price);

  function add() {
    const trimmed = name.trim();
    if (!trimmed) { setError("Give it a name (it prints on the ticket)."); return; }
    if (cents === null) { setError("Type the price, e.g. 2.50"); return; }
    if (cents > 100_000) { setError("That price is too high for an open item."); return; }
    onAdd({
      line_id: initialLine?.line_id ?? uuid(), menu_item_id: OPEN_ITEM_ID, variant_id: null, quantity,
      special_instructions: note.trim().slice(0, 500), modifiers: [], open_item: { name: trimmed.slice(0, 80), price_cents: cents },
    });
  }

  return <div aria-modal="true" className="fixed inset-0 z-50 bg-black/60 p-3 sm:grid sm:place-items-center" role="dialog">
    <form className="mx-auto w-full max-w-lg rounded-3xl bg-white p-5 shadow-2xl" onSubmit={(event) => { event.preventDefault(); add(); }}>
      <div className="flex items-start justify-between gap-3">
        <div><h2 className="text-2xl font-black">Open item</h2><p className="text-sm font-bold text-wayne-muted">Anything not on the menu — name it and price it.</p></div>
        <button aria-label="Close" className="min-h-11 min-w-11 rounded-xl text-2xl font-black hover:bg-wayne-cream" onClick={onClose} type="button">×</button>
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {QUICK_NAMES.map((quick) => <button aria-pressed={name === quick} className={`min-h-11 rounded-full border px-3 text-sm font-black ${name === quick ? "border-wayne-green bg-wayne-green text-white" : "border-wayne-border bg-wayne-cream"}`} key={quick} onClick={() => setName(quick)} type="button">{quick}</button>)}
      </div>
      <label className="mt-3 grid gap-1.5 text-sm font-bold" htmlFor="open-item-name">Name on the ticket
        <input autoComplete="off" className="min-h-12 rounded-xl border border-wayne-border px-3 text-lg font-normal" id="open-item-name" maxLength={80} onChange={(event) => { setName(event.target.value); setError(""); }} value={name} />
      </label>
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
        <label className="grid gap-1.5 text-sm font-bold" htmlFor="open-item-price">Price each ($)
          <input autoComplete="off" autoFocus className="min-h-12 rounded-xl border border-wayne-border px-3 text-2xl font-black" id="open-item-price" inputMode="decimal" onChange={(event) => { setPrice(event.target.value); setError(""); }} placeholder="0.00" value={price} />
        </label>
        <div className="flex items-center gap-2">
          <button aria-label="Fewer" className="h-12 w-12 rounded-xl border text-xl font-black" onClick={() => setQuantity((value) => Math.max(1, value - 1))} type="button">−</button>
          <strong className="w-8 text-center text-xl">{quantity}</strong>
          <button aria-label="More" className="h-12 w-12 rounded-xl border text-xl font-black" onClick={() => setQuantity((value) => Math.min(20, value + 1))} type="button">+</button>
        </div>
      </div>
      <label className="mt-3 grid gap-1.5 text-sm font-bold" htmlFor="open-item-note">Note for the kitchen (optional)
        <input autoComplete="off" className="min-h-11 rounded-xl border border-wayne-border px-3 font-normal" id="open-item-note" maxLength={500} onChange={(event) => setNote(event.target.value)} value={note} />
      </label>
      {error ? <p className="mt-3 rounded-xl bg-wayne-alert-soft p-2 text-sm font-bold text-wayne-alert" role="alert">{error}</p> : null}
      <Button className="mt-4 min-h-14 w-full text-lg" type="submit">{initialLine ? "Update" : "Add"} · {formatCents((cents ?? 0) * quantity)}</Button>
    </form>
  </div>;
}
