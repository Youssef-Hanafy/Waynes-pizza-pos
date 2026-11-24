"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BundleComponent } from "@/lib/menu/bundle-specials";
import { saveBundleSpecialAction } from "../actions";

export type BundleOptions = { id: string; category: string; choices: { value: string; name: string }[] }[];
type Bundle = { id: string; name: string; price: string; endsOn: string | null; revision: number; components: BundleComponent[] };

const field = "min-h-11 min-w-0 rounded-lg border border-wayne-border bg-white px-3 font-normal";

export function BundleForm({ options, initial }: { options: BundleOptions; initial?: Bundle }) {
  const [error, submit, pending] = useActionState(saveBundleSpecialAction, "");
  const [name, setName] = useState(initial?.name ?? "");
  const [price, setPrice] = useState(initial?.price ?? "");
  const [endsOn, setEndsOn] = useState(initial?.endsOn ?? "");
  const [rows, setRows] = useState(() => initial?.components.map((component, index) => ({
    id: index,
    value: `${component.menu_item_id}:${component.variant_id ?? ""}`,
    quantity: String(component.quantity),
    name: component.name,
  })) ?? [{ id: 0, value: "", quantity: "1", name: "" }]);
  const [nextId, setNextId] = useState(rows.length);
  const available = new Set(options.flatMap((group) => group.choices.map((choice) => choice.value)));

  function changeRow(id: number, change: { value?: string; quantity?: string }) {
    setRows((current) => current.map((row) => row.id === id ? { ...row, ...change } : row));
  }

  return (
    <form action={submit} className="mt-4 grid gap-4">
      {initial ? <>
        <input name="id" type="hidden" value={initial.id} />
        <input name="expected_revision" type="hidden" value={initial.revision} />
      </> : null}
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem_10rem]">
        <label className="grid gap-1.5 text-sm font-semibold">Bundle name
          <input className={field} maxLength={160} name="name" onChange={(event) => setName(event.target.value)} placeholder="Two Large Cheese Pizzas" required value={name} />
        </label>
        <label className="grid gap-1.5 text-sm font-semibold">Bundle price ($)
          <input className={field} inputMode="decimal" name="price" onChange={(event) => setPrice(event.target.value)} placeholder="20.99" required value={price} />
        </label>
        <label className="grid gap-1.5 text-sm font-semibold">Ends on (optional)
          <input className={field} name="special_ends_on" onChange={(event) => setEndsOn(event.target.value)} type="date" value={endsOn} />
        </label>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-2 font-bold">Items included</legend>
        {rows.map((row) => (
          <div className="grid grid-cols-[minmax(0,1fr)_5rem_auto] items-end gap-2" key={row.id}>
            <label className="grid gap-1.5 text-sm font-semibold">Item and size
              <select className={field} name="component" onChange={(event) => changeRow(row.id, { value: event.target.value })} required value={row.value}>
                <option disabled value="">Choose an item…</option>
                {row.value && !available.has(row.value) ? <option value={row.value}>{row.name} (unavailable)</option> : null}
                {options.map((group) => <optgroup key={group.id} label={group.category}>
                  {group.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.name}</option>)}
                </optgroup>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-semibold">Quantity
              <input className={field} max={20} min={1} name="component_quantity" onChange={(event) => changeRow(row.id, { quantity: event.target.value })} required type="number" value={row.quantity} />
            </label>
            <Button disabled={rows.length === 1} onClick={() => setRows((current) => current.filter((entry) => entry.id !== row.id))} type="button" variant="secondary">Remove</Button>
          </div>
        ))}
      </fieldset>
      {error ? <p className="text-sm font-semibold text-wayne-alert" role="alert">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={rows.length >= 20} onClick={() => {
          setRows((current) => [...current, { id: nextId, value: "", quantity: "1", name: "" }]);
          setNextId(nextId + 1);
        }} type="button" variant="secondary">Add another item</Button>
        <Button disabled={pending} type="submit">{pending ? "Saving…" : initial ? "Save bundle" : "Create bundle special"}</Button>
      </div>
    </form>
  );
}
