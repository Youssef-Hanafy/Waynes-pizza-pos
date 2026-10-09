"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCents, type PublicMenu } from "@/lib/menu/schemas";
import { cartLineUnitCents, choiceAllowsExtra, choicePriceDeltaCents, includedSelection, isIncludedChoice } from "@/lib/orders/cart";
import type { CartLine } from "@/lib/orders/schemas";
import { uuid } from "@/lib/uuid";

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
    onAdd({ ...draftLine, line_id: initialLine?.line_id ?? uuid() });
  }

  type Group = MenuItem["modifier_groups"][number];
  const renderChoice = (group: Group, choice: Group["choices"][number], compact: boolean) => {
    const count = selectedChoices[choice.id] ?? 0;
    const delta = choicePriceDeltaCents(choice, variantId);
    const comesWith = isIncludedChoice(choice);
    const state = count ? "on" : comesWith ? "removed" : "off";
    const status = state === "removed" ? "NO" : !count ? "" : comesWith ? (count > 1 ? `+${count - 1} extra` : "comes with") : count > 1 ? `× ${count}` : "added";
    const price = delta ? `${delta > 0 ? "+" : ""}${formatCents(delta)}` : "";
    const fullStatus = state === "removed" ? "NO — taken off" : !count ? "not on it" : comesWith ? (count > 1 ? `comes with it + ${count - 1} extra` : "comes with it") : count > 1 ? `added × ${count}` : "added";
    return <div aria-label={`${choice.name}: ${fullStatus}`} className={`grid min-h-0 grid-cols-[2.6rem_1fr_2.6rem] overflow-hidden rounded-lg transition ${state === "on" ? "border-2 border-wayne-ok bg-wayne-ok-soft" : state === "removed" ? "border-2 border-dashed border-wayne-red bg-white" : "border border-wayne-border bg-white"}`} data-state={state} key={choice.id}>
      <button aria-label={`Remove ${choice.name}`} className="bg-wayne-red text-xl font-black text-white disabled:cursor-not-allowed disabled:opacity-30" disabled={!count} onClick={() => setChoiceCount(group, choice.id, count - 1)} type="button">−</button>
      <button aria-label={`${count ? "Take off" : "Put on"} ${choice.name}`} className="flex min-w-0 flex-col justify-center px-2 text-left active:bg-wayne-cream" onClick={() => setChoiceCount(group, choice.id, count ? 0 : 1)} type="button">
        <strong className={`block truncate leading-tight ${compact ? "text-[0.8rem]" : "text-sm"} ${state === "on" ? "text-wayne-ok" : state === "removed" ? "text-wayne-red line-through" : "font-semibold text-wayne-ink/80"}`}>{state === "on" ? "✓ " : ""}{choice.name}</strong>
        {status || price ? <span className={`block truncate text-[0.7rem] leading-tight ${state === "on" ? "font-bold text-wayne-ok" : state === "removed" ? "font-bold text-wayne-red" : "text-wayne-muted"}`}>{[status, price && `${price}${comesWith ? "/extra" : ""}`].filter(Boolean).join(" · ")}</span> : null}
      </button>
      <button aria-label={`Add ${choice.name}`} className="bg-wayne-ok text-xl font-black text-white disabled:cursor-not-allowed disabled:opacity-30" disabled={count > 0 && !choiceAllowsExtra(group, choice)} onClick={() => setChoiceCount(group, choice.id, count + 1)} type="button">+</button>
    </div>;
  };
  const sortedChoices = (group: Group) => [...group.choices].sort((a, b) => Number(isIncludedChoice(b)) - Number(isIncludedChoice(a)));

  return <div aria-modal="true" className="fixed inset-0 z-50 bg-black/60 p-2 sm:p-3" role="dialog">
    <section className="mx-auto flex h-full w-full max-w-[1600px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-wayne-border px-4 py-2.5">
        <div className="min-w-0 flex-1"><h2 className="truncate text-2xl font-black leading-tight">{item.name}</h2>{item.description ? <p className="truncate text-sm text-wayne-muted">{item.description}</p> : null}</div>
        {item.variants.length > 1 ? <div aria-label="Size" className="flex flex-wrap gap-1.5" role="group">{item.variants.map((variant) => <button aria-pressed={variantId === variant.id} className={`min-h-11 rounded-xl border px-3 text-left text-sm leading-tight ${variantId === variant.id ? "border-wayne-ok bg-wayne-ok text-white" : "border-wayne-border bg-white"}`} key={variant.id} onClick={() => setVariantId(variant.id)} type="button"><span className="block font-bold">{variant.name}</span><span className="text-xs font-black">{formatCents(variant.price_cents)}</span></button>)}</div> : null}
        <button aria-label="Close item" className="h-11 w-11 shrink-0 rounded-full border text-xl" onClick={onClose} type="button">×</button>
      </div>
      <ComesWithPanel included={included} onToggle={(group, choiceId, on) => setChoiceCount(group, choiceId, on ? 1 : 0)} selectedChoices={selectedChoices} />
      <OptionColumns groups={item.modifier_groups} renderChoice={renderChoice} sortedChoices={sortedChoices} />
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-wayne-border px-4 py-2.5">
        <input aria-label="Item notes" className="min-h-12 min-w-48 flex-1 rounded-xl border border-wayne-border px-3" maxLength={500} onChange={(event) => setInstructions(event.target.value)} placeholder="Item notes (optional)" value={instructions} />
        <div className="flex items-center gap-2"><button aria-label="Decrease item quantity" className="h-12 w-12 rounded-xl border text-xl" onClick={() => setQuantity(Math.max(1, quantity - 1))} type="button">−</button><strong className="w-6 text-center text-lg">{quantity}</strong><button aria-label="Increase item quantity" className="h-12 w-12 rounded-xl border text-xl" onClick={() => setQuantity(Math.min(20, quantity + 1))} type="button">+</button></div>
        <Button className="min-h-14 px-8 text-lg" onClick={add}>{initialLine ? "Save changes" : "Add to ticket"} · {formatCents(cartLineUnitCents(draftMenu, draftLine) * quantity)}</Button>
        {error ? <p aria-live="polite" className="w-full rounded-lg bg-wayne-alert-soft p-2 font-bold text-wayne-alert">{error}</p> : null}
      </div>
    </section>
  </div>;
}

/**
 * Every option section side by side, sized so the whole item fits the screen
 * with no scrolling (owner request 2026-10-08). A long section (16 sauces)
 * wraps into a second column of its own instead of running off the bottom.
 * Too many options for the screen — or a phone — falls back to scrolling.
 */
function OptionColumns({ groups, renderChoice, sortedChoices }: {
  groups: MenuItem["modifier_groups"];
  renderChoice: (group: MenuItem["modifier_groups"][number], choice: MenuItem["modifier_groups"][number]["choices"][number], compact: boolean) => React.ReactNode;
  sortedChoices: (group: MenuItem["modifier_groups"][number]) => MenuItem["modifier_groups"][number]["choices"];
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ width: number; height: number; bounded: boolean } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setBox({ width: rect.width, height: rect.height, bounded: window.matchMedia("(min-width: 768px)").matches });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (!groups.length) return <div className="min-h-0 flex-1 p-4"><div className="rounded-xl border-2 border-dashed border-wayne-border bg-wayne-cream p-5"><strong>Nothing to choose on this item.</strong><p className="mt-1 text-sm text-wayne-muted">Add it to the ticket, or add an option section in Admin → Menu.</p></div></div>;

  const PAD = 12, GAP = 6, COLUMN_GAP = 12, LABEL = 24, MIN_ROW = 40, MAX_ROW = 60, MIN_COL = 150;
  const layout = (() => {
    if (!box || !box.bounded) return null;
    const usable = box.height - PAD * 2 - LABEL;
    const maxRows = Math.floor((usable + GAP) / (MIN_ROW + GAP));
    if (maxRows < 2) return null;
    const subcols = groups.map((group) => Math.max(1, Math.ceil(group.choices.length / maxRows)));
    const total = subcols.reduce((sum, value) => sum + value, 0);
    if (total * MIN_COL + (groups.length - 1) * COLUMN_GAP + PAD * 2 > box.width) return null;
    const rowsNeeded = Math.max(...groups.map((group, index) => Math.ceil(group.choices.length / subcols[index])));
    const rowHeight = Math.min(MAX_ROW, Math.floor((usable - GAP * (rowsNeeded - 1)) / rowsNeeded));
    return { subcols, rowHeight };
  })();

  return <div className="min-h-0 flex-1 overflow-hidden" ref={ref}>
    {layout ? <div className="grid h-full p-3" style={{ columnGap: COLUMN_GAP, gridTemplateColumns: layout.subcols.map((value) => `minmax(0, ${value}fr)`).join(" ") }}>
      {groups.map((group, index) => <fieldset className="flex min-h-0 min-w-0 flex-col" key={group.id}>
        <legend className="mb-1 truncate text-sm font-black" style={{ height: LABEL - 4 }}>{group.customer_label} <span className="font-normal text-wayne-muted">{group.min_select ? `pick ${group.min_select}–${group.max_select}` : `up to ${group.max_select}`}</span></legend>
        <div className="grid content-start" style={{ gap: GAP, gridAutoRows: layout.rowHeight, gridTemplateColumns: `repeat(${layout.subcols[index]}, minmax(0, 1fr))` }}>
          {sortedChoices(group).map((choice) => renderChoice(group, choice, layout.rowHeight < 48))}
        </div>
      </fieldset>)}
    </div> : <div className="h-full overflow-y-auto p-3">
      {groups.map((group) => <fieldset className="mt-3 first:mt-0" key={group.id}><legend className="font-black">{group.customer_label} <span className="font-normal text-wayne-muted">({group.min_select}–{group.max_select})</span></legend><div className="mt-1.5 grid auto-rows-[3.25rem] gap-1.5 sm:grid-cols-2 lg:grid-cols-3">{sortedChoices(group).map((choice) => renderChoice(group, choice, false))}</div></fieldset>)}
    </div>}
  </div>;
}

/**
 * The answer to "what comes on it?" at a glance: every ingredient the item
 * comes with, lit up while it is on and struck through the moment it is taken
 * off.  Tapping a chip toggles it, the same as the option tiles below.
 */
function ComesWithPanel({ included, onToggle, selectedChoices }: { included: { group: MenuItem["modifier_groups"][number]; choice: MenuItem["modifier_groups"][number]["choices"][number] }[]; onToggle: (group: MenuItem["modifier_groups"][number], choiceId: string, on: boolean) => void; selectedChoices: Record<string, number> }) {
  if (!included.length) return <p className="shrink-0 border-b border-wayne-border bg-wayne-cream px-4 py-1.5 text-xs font-semibold">Nothing comes on this by default — tap an option to add it. Red − takes a portion off, green + adds one.</p>;
  const removed = included.filter(({ choice }) => !selectedChoices[choice.id]).length;
  return <section aria-label="Comes with" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-wayne-border bg-wayne-ok-soft px-4 py-1.5">
    <span className="mr-1 text-xs font-black uppercase tracking-[0.14em] text-wayne-ok">Comes with{removed ? <span className="ml-1.5 rounded bg-wayne-red px-1.5 py-0.5 tracking-normal text-white">{removed} off</span> : null}</span>
    {included.map(({ group, choice }) => {
      const on = Boolean(selectedChoices[choice.id]);
      return <button aria-pressed={on} className={`min-h-9 rounded-full px-3 text-sm font-black transition active:scale-95 ${on ? "bg-wayne-ok text-white shadow-sm" : "border-2 border-dashed border-wayne-red bg-white text-wayne-red line-through"}`} key={choice.id} onClick={() => onToggle(group, choice.id, !on)} type="button">{on ? "✓ " : "NO "}{choice.name}</button>;
    })}
  </section>;
}
