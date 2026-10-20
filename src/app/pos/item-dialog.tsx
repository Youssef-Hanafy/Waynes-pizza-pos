"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCents, type PublicMenu } from "@/lib/menu/schemas";
import { cartLineUnitCents, choiceAllowsExtra, choicePriceDeltaCents, countedPortions, groupAllowanceLines, groupMaxPortions, groupSizeRule, includedSelection, isIncludedChoice, isExtraChoice, isInstructionChoice } from "@/lib/orders/cart";
import type { CartLine, ToppingPlacement } from "@/lib/orders/schemas";
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
  /** Toppings on one half of a pizza (owner, 2026-10-20); a topping not listed here is on the whole pizza. */
  const [sides, setSides] = useState<Record<string, ToppingPlacement>>(() => Object.fromEntries((initialLine?.modifiers ?? []).flatMap((modifier) => (modifier.placement ? [[modifier.choice_id, modifier.placement] as const] : []))));
  const [quantity, setQuantity] = useState(initialLine?.quantity ?? 1);
  const [instructions, setInstructions] = useState(initialLine?.special_instructions ?? "");
  const [error, setError] = useState("");

  /** Options whose group offers Left / Whole / Right (Admin → the option group → halves). */
  const halvesChoiceIds = new Set(item.modifier_groups.filter((group) => group.allow_halves).flatMap((group) => group.choices.map((choice) => choice.id)));
  const draftLine: CartLine = {
    line_id: "draft",
    menu_item_id: item.id,
    variant_id: variantId,
    quantity,
    special_instructions: instructions,
    modifiers: lineModifiers(selectedChoices, sides),
  };
  const draftMenu = [{ id: "00000000-0000-4000-8000-000000000000", name: "", description: "", image_path: null, image_alt: "", items: [item] }] as PublicMenu;
  // Everything this item comes with, once each, in menu order.
  const included = item.modifier_groups.flatMap((group) => group.choices.filter(isIncludedChoice).map((choice) => ({ group, choice }))).filter((entry, index, all) => all.findIndex((other) => other.choice.id === entry.choice.id) === index);

  /** The ticket's modifiers: each picked option once, with its half when its group offers halves. */
  function lineModifiers(choices: Record<string, number>, chosenSides: Record<string, ToppingPlacement>) {
    return Object.entries(choices).filter(([, count]) => count > 0).map(([choice_id, count]) => {
      const side = halvesChoiceIds.has(choice_id) ? chosenSides[choice_id] : undefined;
      return side ? { choice_id, quantity: count, placement: side } : { choice_id, quantity: count };
    });
  }

  function groupCount(group: MenuItem["modifier_groups"][number]) {
    return group.choices.reduce((total, choice) => total + (selectedChoices[choice.id] ?? 0), 0);
  }
  const variantName = item.variants.find((variant) => variant.id === variantId)?.name ?? null;
  /** Included-portions rule for this group on the chosen size ("Large: 3 sauces free"). */
  const ruleFor = (group: MenuItem["modifier_groups"][number]) => groupSizeRule(group, variantName);

  function setChoiceCount(group: MenuItem["modifier_groups"][number], choiceId: string, nextCount: number, nextSides: Record<string, ToppingPlacement> = sides) {
    const currentCount = selectedChoices[choiceId] ?? 0;
    const choice = group.choices.find((option) => option.id === choiceId);
    const rule = ruleFor(group);
    // With a size rule only real portions count ("No Sauce" doesn't).
    const most = groupMaxPortions(group, rule);
    const othersCount = rule ? countedPortions(group, { ...selectedChoices, [choiceId]: 0 }) : groupCount(group) - currentCount;
    const limit = rule && choice && isInstructionChoice(choice) ? 1 : Math.max(0, most - othersCount);
    const multiple = choice ? choiceAllowsExtra(group, choice) : group.allow_quantities;
    const safeCount = Math.max(0, Math.min(multiple ? nextCount : Number(nextCount > 0), limit));
    if (nextCount > currentCount && safeCount === currentCount) {
      setError(`You can choose up to ${most} in ${group.customer_label}${rule && variantName ? ` on a ${variantName}` : ""}. Remove one first to change it.`);
      return;
    }
    setError("");
    const next = { ...selectedChoices, [choiceId]: safeCount };
    setSelectedChoices(next);
    // Taken off: it's on no half any more.
    const sidesNow = safeCount ? nextSides : Object.fromEntries(Object.entries(nextSides).filter(([id]) => id !== choiceId));
    if (sidesNow !== sides) setSides(sidesNow);
    if (safeCount > currentCount && group.id === pickGroup?.id && sizeTapped && pickComplete(next, variantId)) addWith(next, variantId, sidesNow);
  }

  /** Left / Whole / Right on a topping: puts it on (if it wasn't) on that part of the pizza. */
  function placeChoice(group: MenuItem["modifier_groups"][number], choiceId: string, side: ToppingPlacement | "whole") {
    const nextSides = { ...sides };
    if (side === "whole") delete nextSides[choiceId]; else nextSides[choiceId] = side;
    const count = selectedChoices[choiceId] ?? 0;
    if (count) { setSides(nextSides); setError(""); return; }
    setChoiceCount(group, choiceId, 1, nextSides);
  }

  function add() { addWith(selectedChoices, variantId, sides); }

  function addWith(choices: Record<string, number>, chosenVariantId: string | null, chosenSides: Record<string, ToppingPlacement>) {
    const chosenName = item.variants.find((variant) => variant.id === chosenVariantId)?.name ?? null;
    for (const group of item.modifier_groups) {
      const count = group.choices.reduce((total, choice) => total + (choices[choice.id] ?? 0), 0);
      if (count < group.min_select || count > group.max_select || (group.required && !count)) {
        setError(`${group.customer_label}: choose ${group.min_select}–${group.max_select}.`);
        return;
      }
      const rule = groupSizeRule(group, chosenName);
      if (rule?.max_portions && countedPortions(group, choices) > rule.max_portions) {
        setError(`${group.customer_label}: up to ${rule.max_portions}${chosenName ? ` on a ${chosenName}` : ""}. Take some off first.`);
        return;
      }
    }
    onAdd({
      ...draftLine,
      variant_id: chosenVariantId,
      modifiers: lineModifiers(choices, chosenSides),
      line_id: initialLine?.line_id ?? uuid(),
    });
  }

  /**
   * Auto-add (owner, 2026-10-19): an item marked in Admin (One / Two / Three
   * Topping Pizza) goes on the ticket by itself the moment its first option
   * group is full — e.g. the topping on a One Topping Pizza — once the size
   * has been tapped.  Every other item keeps its Add to ticket button, and
   * editing a line on the ticket never adds by itself.
   */
  const pickGroup = !initialLine && item.pos_auto_add ? item.modifier_groups[0] ?? null : null;
  // The first size is already picked (Large first on pizzas, owner 2026-10-20), so picking the
  // topping(s) is enough; tapping another size first still works.
  const [sizeTapped, setSizeTapped] = useState(true);
  function pickComplete(choices: Record<string, number>, chosenVariantId: string | null) {
    if (!pickGroup) return false;
    const rule = groupSizeRule(pickGroup, item.variants.find((variant) => variant.id === chosenVariantId)?.name ?? null);
    const target = groupMaxPortions(pickGroup, rule);
    const picked = rule ? countedPortions(pickGroup, choices) : pickGroup.choices.reduce((total, choice) => total + (choices[choice.id] ?? 0), 0);
    return target > 0 && picked >= target;
  }
  function chooseSize(nextVariantId: string) {
    setVariantId(nextVariantId);
    setSizeTapped(true);
    if (pickComplete(selectedChoices, nextVariantId)) addWith(selectedChoices, nextVariantId, sides);
  }

  return <div aria-modal="true" className="fixed inset-0 z-50 bg-black/60 p-3 sm:grid sm:place-items-center" role="dialog">
    <section className="mx-auto flex max-h-[96vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-wayne-border p-5">
        <div><p className="text-xs font-black uppercase tracking-[0.18em] text-wayne-ok">Front POS customizer</p><h2 className="mt-1 text-3xl font-black">{item.name}</h2><p className="mt-1 text-wayne-muted">{item.description}</p></div>
        <button aria-label="Close item" className="h-12 w-12 shrink-0 rounded-full border text-xl" onClick={onClose}>×</button>
      </div>
      <div className="overflow-y-auto p-5">
        <ComesWithPanel included={included} onToggle={(group, choiceId, on) => setChoiceCount(group, choiceId, on ? 1 : 0)} selectedChoices={selectedChoices} />
        {halvesChoiceIds.size ? <PizzaHalves groups={item.modifier_groups.filter((group) => group.allow_halves)} selectedChoices={selectedChoices} sides={sides} /> : null}
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-semibold text-wayne-muted"><span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-wayne-ok" /> on the item</span><span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm border-2 border-dashed border-wayne-red" /> comes with it, taken off</span><span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm border border-wayne-border bg-white" /> not on it</span><span>Red − takes a portion off, green + adds one. What it comes with is free; extra portions are charged.</span></p>
        {item.variants.length ? <fieldset className="mt-5"><legend className="font-black">Size{pickGroup && !sizeTapped ? <span className="ml-2 font-bold text-wayne-red">tap the size first — the item adds itself once its {pickGroup.customer_label.toLowerCase()} {pickGroup.max_select === 1 ? "is" : "are"} picked</span> : null}</legend><div className="mt-2 grid gap-2 sm:grid-cols-3">{item.variants.map((variant) => <button className={`min-h-14 rounded-xl border p-3 text-left ${variantId === variant.id ? "border-wayne-ok bg-wayne-ok/10" : "border-wayne-border"}`} key={variant.id} onClick={() => chooseSize(variant.id)} type="button"><span className="block font-bold">{variant.name}</span><strong>{formatCents(variant.price_cents)}</strong></button>)}</div></fieldset> : null}
        {item.modifier_groups.length ? item.modifier_groups.map((group) => {
          const rule = ruleFor(group);
          const allowance = rule ? groupAllowanceLines(group, rule, variantId, Object.entries(selectedChoices).map(([choice_id, quantity]) => ({ choice_id, quantity }))) : [];
          const used = rule ? countedPortions(group, selectedChoices) : 0;
          return <fieldset className="mt-5" key={group.id}><legend className="font-black">{group.customer_label} <span className="font-normal text-wayne-muted">({group.min_select}–{groupMaxPortions(group, rule)})</span></legend>
          {rule ? <p className={`mt-1 inline-block rounded-lg px-3 py-1 text-sm font-black ${used > rule.included_count ? "bg-wayne-warn-soft" : "bg-wayne-ok-soft text-wayne-ok"}`}>
            {rule.included_count} included{variantName ? ` on a ${variantName}` : ""} · {Math.min(used, rule.included_count)} of {rule.included_count} used{used > rule.included_count ? ` · ${used - rule.included_count} extra` : ""}{rule.extra_each_cents !== null ? ` · extra ${formatCents(rule.extra_each_cents)} each` : ""}{rule.max_portions ? ` · up to ${rule.max_portions}` : ""}
          </p> : null}
          <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">{[...group.choices].sort((a, b) => Number(isIncludedChoice(b)) - Number(isIncludedChoice(a))).map((choice) => {
          const count = selectedChoices[choice.id] ?? 0;
          const delta = choicePriceDeltaCents(choice, variantId);
          const comesWith = isIncludedChoice(choice);
          const state = count ? "on" : comesWith ? "removed" : "off";
          const portion = allowance.find((entry) => entry.choice_id === choice.id);
          const ruled = rule && !isInstructionChoice(choice) && !isExtraChoice(choice);
          const status = ruled
            ? (!count ? (comesWith ? "NO — taken off" : "not on it") : `× ${count}${portion ? ` · ${portion.free} free${portion.portions > portion.free ? ` + ${portion.portions - portion.free} extra` : ""}` : ""}`)
            : state === "removed" ? "NO — taken off" : !count ? "not on it" : comesWith ? (count > 1 ? `comes with it + ${count - 1} extra` : "comes with it") : count > 1 ? `added × ${count}` : "added";
          const side = count && group.allow_halves ? sides[choice.id] : undefined;
          const extraEach = rule?.extra_each_cents ?? delta;
          const price = ruled
            ? (portion && portion.charge_cents ? ` · +${formatCents(portion.charge_cents)}` : extraEach && used >= (rule?.included_count ?? 0) ? ` · next +${formatCents(extraEach)}` : "")
            : delta ? ` · ${delta > 0 ? "+" : ""}${formatCents(delta)}${comesWith ? " per extra" : choiceAllowsExtra(group, choice) ? " each" : ""}` : "";
          return <div aria-label={`${choice.name}: ${status}`} className={`grid min-h-16 grid-cols-[3.25rem_1fr_3.25rem] overflow-hidden rounded-xl transition ${state === "on" ? "border-2 border-wayne-ok bg-wayne-ok-soft shadow-[0_0_0_3px_rgba(29,122,76,0.18)]" : state === "removed" ? "border-2 border-dashed border-wayne-red bg-white" : "border border-wayne-border bg-white"}`} data-state={state} key={choice.id}>
            <button aria-label={`Remove ${choice.name}`} className="bg-wayne-red px-2 text-2xl font-black text-white disabled:cursor-not-allowed disabled:opacity-35" disabled={!count} onClick={() => setChoiceCount(group, choice.id, count - 1)} type="button">−</button>
            <div className="flex min-w-0 flex-col justify-center px-3"><strong className={`truncate ${state === "on" ? "text-wayne-ok" : state === "removed" ? "text-wayne-red line-through" : "font-semibold text-wayne-ink/70"}`}>{state === "on" ? "✓ " : ""}{choice.name}</strong><span className={`text-xs ${state === "on" ? "font-bold text-wayne-ok" : state === "removed" ? "font-bold text-wayne-red" : "text-wayne-muted"}`}>{side === "left" ? "LEFT ½ · " : side === "right" ? "RIGHT ½ · " : ""}{status}{price}</span>
              {group.allow_halves && !isInstructionChoice(choice) ? <div aria-label={`${choice.name}: which part of the pizza`} className="mt-1.5 grid grid-cols-3 gap-1" role="group">
                {(["left", "whole", "right"] as const).map((part) => {
                  const on = Boolean(count) && (side ?? "whole") === part;
                  return <button aria-label={`${choice.name} on the ${part === "whole" ? "whole pizza" : `${part} half`}`} aria-pressed={on} className={`flex min-h-10 items-center justify-center gap-1 rounded-lg border-2 px-1 text-xs font-black transition active:scale-95 ${on ? "border-wayne-ok bg-wayne-ok text-white" : "border-wayne-border bg-white text-wayne-ink"}`} key={part} onClick={() => placeChoice(group, choice.id, part)} type="button"><PizzaPart on={on} part={part} />{part === "left" ? "Left" : part === "right" ? "Right" : "Whole"}</button>;
                })}
              </div> : null}</div>
            <button aria-label={`Add ${choice.name}`} className="bg-wayne-ok px-2 text-2xl font-black text-white disabled:cursor-not-allowed disabled:opacity-35" disabled={count > 0 && !choiceAllowsExtra(group, choice)} onClick={() => setChoiceCount(group, choice.id, count + 1)} type="button">+</button>
          </div>;
        })}</div></fieldset>;
        }) : <div className="mt-5 rounded-xl border-2 border-dashed border-wayne-border bg-wayne-cream p-5"><strong>No modifier group is assigned to this item yet.</strong><p className="mt-1 text-sm text-wayne-muted">The menu configuration needs a customization group before ingredients can be adjusted. This screen will show it as soon as it is assigned.</p></div>}
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

/** A small pizza with the chosen part filled in: the left half, the whole pizza, or the right half. */
function PizzaPart({ part, on, size = 18 }: { part: "left" | "whole" | "right"; on: boolean; size?: number }) {
  const fill = on ? "#ffffff" : "#c3311d";
  const ring = on ? "#ffffff" : "#6b615a";
  return <svg aria-hidden className="shrink-0" height={size} viewBox="0 0 20 20" width={size}>
    <circle cx="10" cy="10" fill="none" r="8.5" stroke={ring} strokeWidth="1.5" />
    {part === "whole" ? <circle cx="10" cy="10" fill={fill} r="6.5" />
      : <path d={part === "left" ? "M10 3.5 A6.5 6.5 0 0 0 10 16.5 Z" : "M10 3.5 A6.5 6.5 0 0 1 10 16.5 Z"} fill={fill} />}
    <line stroke={ring} strokeDasharray="1.5 1.5" strokeWidth="1" x1="10" x2="10" y1="1.5" y2="18.5" />
  </svg>;
}

/**
 * The pizza at a glance (owner, 2026-10-20: "a small circle"): what is on the
 * left half, the right half and the whole pizza, from the Left / Whole / Right
 * buttons below.
 */
function PizzaHalves({ groups, selectedChoices, sides }: { groups: MenuItem["modifier_groups"]; selectedChoices: Record<string, number>; sides: Record<string, ToppingPlacement> }) {
  const picked = groups.flatMap((group) => group.choices.filter((choice) => (selectedChoices[choice.id] ?? 0) > 0 && !isInstructionChoice(choice)))
    .filter((choice, index, all) => all.findIndex((other) => other.id === choice.id) === index);
  const names = (part: "left" | "whole" | "right") => picked.filter((choice) => (sides[choice.id] ?? "whole") === part).map((choice) => `${choice.name}${(selectedChoices[choice.id] ?? 0) > 1 ? ` ×${selectedChoices[choice.id]}` : ""}`);
  const left = names("left"); const right = names("right"); const whole = names("whole");
  return <section aria-label="Pizza halves" className="mt-3 flex items-center gap-3 rounded-xl border border-wayne-border bg-white p-3">
    <svg aria-hidden className="shrink-0" height="64" viewBox="0 0 64 64" width="64">
      <circle cx="32" cy="32" fill="#f0b429" r="30" stroke="#9d1f18" strokeWidth="3" />
      <path d="M32 6 A26 26 0 0 0 32 58 Z" fill={left.length ? "#c3311d" : whole.length ? "#e8873a" : "#f8e3b0"} />
      <path d="M32 6 A26 26 0 0 1 32 58 Z" fill={right.length ? "#1f4b3a" : whole.length ? "#e8873a" : "#f8e3b0"} />
      <line stroke="#ffffff" strokeWidth="2.5" x1="32" x2="32" y1="4" y2="60" />
      <text fill="#ffffff" fontSize="13" fontWeight="900" textAnchor="middle" x="20" y="37">L</text>
      <text fill="#ffffff" fontSize="13" fontWeight="900" textAnchor="middle" x="44" y="37">R</text>
    </svg>
    <div className="grid min-w-0 flex-1 gap-0.5 text-sm">
      <p className="truncate"><strong className="text-wayne-red">LEFT ½:</strong> {left.length ? left.join(", ") : <span className="text-wayne-muted">—</span>}</p>
      <p className="truncate"><strong className="text-wayne-green">RIGHT ½:</strong> {right.length ? right.join(", ") : <span className="text-wayne-muted">—</span>}</p>
      <p className="truncate"><strong>WHOLE:</strong> {whole.length ? whole.join(", ") : <span className="text-wayne-muted">—</span>}</p>
    </div>
  </section>;
}
