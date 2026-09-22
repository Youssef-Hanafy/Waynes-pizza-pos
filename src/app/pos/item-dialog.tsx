"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCents, type PublicMenu } from "@/lib/menu/schemas";
import { cartLineUnitCents, choiceAllowsExtra, choicePriceDeltaCents, includedSelection, isIncludedChoice } from "@/lib/orders/cart";
import type { CartLine } from "@/lib/orders/schemas";

type MenuItem = PublicMenu[number]["items"][number];

/**
 * The front counter needs a fast, visual way to adjust a recipe.  The red and
 * green controls intentionally mirror the legacy terminal: red removes an
 * included portion, green adds another portion.  Quantity is carried through
 * to the order API, so configured per-portion prices are charged correctly.
 */
export function PosItemDialog({ initialLine, item, onAdd, onClose }: { initialLine: CartLine | null; item: MenuItem; onAdd: (line: CartLine) => void; onClose: () => void }) {
  const [variantId, setVariantId] = useState<string | null>(initialLine?.variant_id ?? item.variants[0]?.id ?? null);
  const [selectedChoices, setSelectedChoices] = useState<Record<string, number>>(() => initialLine
    ? Object.fromEntries(initialLine.modifiers.map((modifier) => [modifier.choice_id, modifier.quantity]))
    : includedSelection(item));
  const [quantity, setQuantity] = useState(initialLine?.quantity ?? 1);
  const [instructions, setInstructions] = useState(initialLine?.special_instructions ?? "");
  const [error, setError] = useState("");

  const draftLine: CartLine = {
    line_id: "draft",
    menu_item_id: item.id,
    variant_id: variantId,
    quantity,
    special_instructions: instructions,
    modifiers: Object.entries(selectedChoices).filter(([, count]) => count > 0).map(([choice_id, count]) => ({ choice_id, quantity: count })),
  };
  const draftMenu = [{ id: "00000000-0000-4000-8000-000000000000", name: "", description: "", image_path: null, image_alt: "", items: [item] }] as PublicMenu;
  // Everything this item comes with, once each, in menu order.
  const included = item.modifier_groups.flatMap((group) => group.choices.filter(isIncludedChoice).map((choice) => ({ group, choice }))).filter((entry, index, all) => all.findIndex((other) => other.choice.id === entry.choice.id) === index);

  function groupCount(group: MenuItem["modifier_groups"][number]) {
    return group.choices.reduce((total, choice) => total + (selectedChoices[choice.id] ?? 0), 0);
  }

  function setChoiceCount(group: MenuItem["modifier_groups"][number], choiceId: string, nextCount: number) {
    const currentCount = selectedChoices[choiceId] ?? 0;
    const othersCount = groupCount(group) - currentCount;
    const limit = Math.max(0, group.max_select - othersCount);
    const choice = group.choices.find((option) => option.id === choiceId);
    const multiple = choice ? choiceAllowsExtra(group, choice) : group.allow_quantities;
    const safeCount = Math.max(0, Math.min(multiple ? nextCount : Number(nextCount > 0), limit));
    if (nextCount > currentCount && safeCount === currentCount) {
      setError(`You can choose up to ${group.max_select} in ${group.customer_label}. Remove one first to change it.`);
      return;
    }
    setError("");
    setSelectedChoices((current) => ({ ...current, [choiceId]: safeCount }));
  }

  function add() {
    for (const group of item.modifier_groups) {
      const count = groupCount(group);
      if (count < group.min_select || count > group.max_select || (group.required && !count)) {
        setError(`${group.customer_label}: choose ${group.min_select}–${group.max_select}.`);
        return;
      }
    }
    onAdd({ ...draftLine, line_id: initialLine?.line_id ?? crypto.randomUUID() });
  }

  return <div aria-modal="true" className="fixed inset-0 z-50 bg-black/60 p-3 sm:grid sm:place-items-center" role="dialog">
    <section className="mx-auto flex max-h-[96vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-wayne-border p-5">
        <div><p className="text-xs font-black uppercase tracking-[0.18em] text-wayne-ok">Front POS customizer</p><h2 className="mt-1 text-3xl font-black">{item.name}</h2><p className="mt-1 text-wayne-muted">{item.description}</p></div>
        <button aria-label="Close item" className="h-12 w-12 shrink-0 rounded-full border text-xl" onClick={onClose}>×</button>
      </div>
      <div className="overflow-y-auto p-5">
        <ComesWithPanel included={included} onToggle={(group, choiceId, on) => setChoiceCount(group, choiceId, on ? 1 : 0)} selectedChoices={selectedChoices} />
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-wayne-muted"><span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-wayne-ok" /> on the item</span><span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm border-2 border-dashed border-wayne-red" /> comes with it, taken off</span><span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm border border-wayne-border bg-white" /> not on it</span><span>Red − takes a portion off, green + adds one. What it comes with is free; extra portions are charged.</span></p>
        {item.variants.length ? <fieldset className="mt-5"><legend className="font-black">Size</legend><div className="mt-2 grid gap-2 sm:grid-cols-3">{item.variants.map((variant) => <button className={`min-h-14 rounded-xl border p-3 text-left ${variantId === variant.id ? "border-wayne-ok bg-wayne-ok/10" : "border-wayne-border"}`} key={variant.id} onClick={() => setVariantId(variant.id)} type="button"><span className="block font-bold">{variant.name}</span><strong>{formatCents(variant.price_cents)}</strong></button>)}</div></fieldset> : null}
        {item.modifier_groups.length ? item.modifier_groups.map((group) => <fieldset className="mt-5" key={group.id}><legend className="font-black">{group.customer_label} <span className="font-normal text-wayne-muted">({group.min_select}–{group.max_select})</span></legend><div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">{[...group.choices].sort((a, b) => Number(isIncludedChoice(b)) - Number(isIncludedChoice(a))).map((choice) => {
          const count = selectedChoices[choice.id] ?? 0;
          const delta = choicePriceDeltaCents(choice, variantId);
          const comesWith = isIncludedChoice(choice);
          const state = count ? "on" : comesWith ? "removed" : "off";
          const status = state === "removed" ? "NO — taken off" : !count ? "not on it" : comesWith ? (count > 1 ? `comes with it + ${count - 1} extra` : "comes with it") : count > 1 ? `added × ${count}` : "added";
          const price = delta ? ` · ${delta > 0 ? "+" : ""}${formatCents(delta)}${comesWith ? " per extra" : choiceAllowsExtra(group, choice) ? " each" : ""}` : "";
          return <div aria-label={`${choice.name}: ${status}`} className={`grid min-h-16 grid-cols-[3.25rem_1fr_3.25rem] overflow-hidden rounded-xl transition ${state === "on" ? "border-2 border-wayne-ok bg-wayne-ok-soft shadow-[0_0_0_3px_rgba(29,122,76,0.18)]" : state === "removed" ? "border-2 border-dashed border-wayne-red bg-white" : "border border-wayne-border bg-white"}`} data-state={state} key={choice.id}>
            <button aria-label={`Remove ${choice.name}`} className="bg-wayne-red px-2 text-2xl font-black text-white disabled:cursor-not-allowed disabled:opacity-35" disabled={!count} onClick={() => setChoiceCount(group, choice.id, count - 1)} type="button">−</button>
            <div className="flex min-w-0 flex-col justify-center px-3"><strong className={`truncate ${state === "on" ? "text-wayne-ok" : state === "removed" ? "text-wayne-red line-through" : "font-semibold text-wayne-ink/70"}`}>{state === "on" ? "✓ " : ""}{choice.name}</strong><span className={`text-xs ${state === "on" ? "font-bold text-wayne-ok" : state === "removed" ? "font-bold text-wayne-red" : "text-wayne-muted"}`}>{status}{price}</span></div>
            <button aria-label={`Add ${choice.name}`} className="bg-wayne-ok px-2 text-2xl font-black text-white disabled:cursor-not-allowed disabled:opacity-35" disabled={count > 0 && !choiceAllowsExtra(group, choice)} onClick={() => setChoiceCount(group, choice.id, count + 1)} type="button">+</button>
          </div>;
        })}</div></fieldset>) : <div className="mt-5 rounded-xl border-2 border-dashed border-wayne-border bg-wayne-cream p-5"><strong>No modifier group is assigned to this item yet.</strong><p className="mt-1 text-sm text-wayne-muted">The menu configuration needs a customization group before ingredients can be adjusted. This screen will show it as soon as it is assigned.</p></div>}
        <label className="mt-5 grid gap-2 font-bold">Item notes<textarea className="rounded-xl border p-3 font-normal" maxLength={500} onChange={(event) => setInstructions(event.target.value)} rows={2} value={instructions} /></label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-wayne-border p-5"><div className="flex items-center gap-2"><button aria-label="Decrease item quantity" className="h-12 w-12 rounded-xl border" onClick={() => setQuantity(Math.max(1, quantity - 1))} type="button">−</button><strong>{quantity}</strong><button aria-label="Increase item quantity" className="h-12 w-12 rounded-xl border" onClick={() => setQuantity(Math.min(20, quantity + 1))} type="button">+</button></div><Button className="min-h-14" onClick={add}>{initialLine ? "Save changes" : "Add to ticket"} · {formatCents(cartLineUnitCents(draftMenu, draftLine) * quantity)}</Button></div>
      {error ? <p aria-live="polite" className="mx-5 mb-5 rounded-lg bg-wayne-alert-soft p-3 font-bold text-wayne-alert">{error}</p> : null}
    </section>
  </div>;
}

/**
 * The answer to "what comes on it?" at a glance: every ingredient the item
 * comes with, lit up while it is on and struck through the moment it is taken
 * off.  Tapping a chip toggles it, the same as the red and green buttons below.
 */
function ComesWithPanel({ included, onToggle, selectedChoices }: { included: { group: MenuItem["modifier_groups"][number]; choice: MenuItem["modifier_groups"][number]["choices"][number] }[]; onToggle: (group: MenuItem["modifier_groups"][number], choiceId: string, on: boolean) => void; selectedChoices: Record<string, number> }) {
  if (!included.length) return <p className="rounded-xl border border-wayne-border bg-wayne-cream p-3 text-sm font-semibold">Nothing comes on this by default — every topping below is an add-on.</p>;
  const removed = included.filter(({ choice }) => !selectedChoices[choice.id]).length;
  return <section aria-label="Comes with" className="rounded-xl border-2 border-wayne-ok bg-wayne-ok-soft p-3">
    <p className="text-xs font-black uppercase tracking-[0.16em] text-wayne-ok">Comes with{removed ? <span className="ml-2 rounded bg-wayne-red px-1.5 py-0.5 tracking-normal text-white">{removed} taken off</span> : null}</p>
    <div className="mt-2 flex flex-wrap gap-2">{included.map(({ group, choice }) => {
      const on = Boolean(selectedChoices[choice.id]);
      return <button aria-pressed={on} className={`min-h-10 rounded-full px-3 text-sm font-black transition active:scale-95 ${on ? "bg-wayne-ok text-white shadow-sm" : "border-2 border-dashed border-wayne-red bg-white text-wayne-red line-through"}`} key={choice.id} onClick={() => onToggle(group, choice.id, !on)} type="button">{on ? "✓ " : "NO "}{choice.name}</button>;
    })}</div>
  </section>;
}
