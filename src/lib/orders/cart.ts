import type { PublicMenu } from "@/lib/menu/schemas";
import { cartLineSchema, type CartLine } from "./schemas";

// v2: lines now list what the item comes with.  A v1 cart never pre-selected
// included toppings, so reading one as v2 would turn a Meat Lovers into
// "NO pepperoni, NO sausage…" -- old carts are simply left behind.
export const CART_STORAGE_KEY = "wayne-cart-v2";

export function readCart(value: string | null): CartLine[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    const result = cartLineSchema.array().safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

export function findMenuItem(menu: PublicMenu, itemId: string) {
  return menu
    .flatMap((category) => category.items)
    .find((item) => item.id === itemId);
}

// A modifier's price can vary by size (Phase 14): Mushrooms might be +$1 on a
// Small pizza and +$2 on a Large. `variant_prices` carries the sizes that have
// an explicit override; anything else -- including every choice on an item
// with no sizes at all -- uses the flat `price_delta_cents`.
export function choicePriceDeltaCents(
  choice: { price_delta_cents: number; variant_prices: { variant_id: string; price_delta_cents: number }[] },
  variantId: string | null | undefined,
) {
  if (variantId) {
    const override = choice.variant_prices.find((entry) => entry.variant_id === variantId);
    if (override) return override.price_delta_cents;
  }
  return choice.price_delta_cents;
}

type ChoiceLike = {
  id: string;
  name: string;
  default_selected: boolean;
  price_delta_cents: number;
  variant_prices: { variant_id: string; price_delta_cents: number }[];
};
type ItemLike = { modifier_groups: { choices: ChoiceLike[] }[] };

// `default_selected` in the menu feed means "this item comes with it": the
// database sets it per item from the "Comes with" list (or the Admin -> Menu
// checkbox).  The first portion is already in the item's price.
export function isIncludedChoice(choice: { default_selected: boolean }) {
  return choice.default_selected;
}

/**
 * Whether a customer can ask for more than one portion of this option: the
 * group allows quantities (toppings, cheese, sauces, extra dressings -- see
 * migrations 20260925080000 and 20260928080000), except for instructions like
 * "No Sauce" or "Light Cheese", which only make sense once.
 */
export function choiceAllowsExtra(group: { allow_quantities: boolean }, choice: { name: string }) {
  return group.allow_quantities && !/^(no|light|lite)\b/i.test(choice.name.trim());
}

// The portions of a selected option that are actually charged.
export function chargedPortions(choice: { default_selected: boolean }, portions: number) {
  return Math.max(0, portions - (isIncludedChoice(choice) ? 1 : 0));
}

// Starting selection for a fresh item: everything it comes with, once.
export function includedSelection(item: ItemLike): Record<string, number> {
  return Object.fromEntries(
    item.modifier_groups.flatMap((group) =>
      group.choices.filter(isIncludedChoice).map((choice) => [choice.id, 1] as const),
    ),
  );
}

export type LineModifierNote = { kind: "removed" | "extra" | "added"; label: string };

/** "LEFT ½ " / "RIGHT ½ " in front of a topping on one half of a pizza (same words as the kitchen slip). */
export function placementPrefix(placement: "left" | "right" | undefined) {
  return placement === "left" ? "LEFT ½ " : placement === "right" ? "RIGHT ½ " : "";
}

/**
 * How a line reads on a ticket or in a cart: only what differs from the
 * recipe.  Kept included toppings are not repeated; a removed one reads
 * "NO Onion"; extra portions of an included one read "Extra Pepperoni".
 */
export function describeLineModifiers(item: ItemLike | undefined, line: Pick<CartLine, "modifiers">): LineModifierNote[] {
  if (!item) return [];
  const choices = new Map<string, ChoiceLike>();
  for (const group of item.modifier_groups) for (const choice of group.choices) if (!choices.has(choice.id)) choices.set(choice.id, choice);
  const selected = new Map(line.modifiers.map((modifier) => [modifier.choice_id, modifier.quantity]));
  const notes: LineModifierNote[] = [];
  for (const choice of choices.values()) {
    if (isIncludedChoice(choice) && !selected.get(choice.id)) notes.push({ kind: "removed", label: `NO ${choice.name}` });
  }
  for (const modifier of line.modifiers) {
    const choice = choices.get(modifier.choice_id);
    if (!choice) continue;
    const side = placementPrefix(modifier.placement);
    if (isIncludedChoice(choice)) {
      // Something it comes with, moved to one half, is worth saying even with no extra.
      if (side) notes.push({ kind: "added", label: `${side}${choice.name}` });
      const extra = modifier.quantity - 1;
      if (extra > 0) notes.push({ kind: "extra", label: `${side}${extra > 1 ? `${extra}× ` : ""}Extra ${choice.name}` });
    } else {
      notes.push({ kind: "added", label: `${side}${modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}${choice.name}` });
    }
  }
  return notes;
}

export type SizeRule = { variant_name: string; included_count: number; max_portions: number | null; extra_each_cents: number | null };
type RuledGroup = { size_rules?: SizeRule[]; max_select: number; choices: ChoiceLike[] };

/** "Extra Cheese", "Extra Sauce": an extra by name, never one of the free picks (mirrors wayne_is_extra_choice). */
export function isExtraChoice(choice: { name: string }) {
  return /^\s*extra\b/i.test(choice.name);
}

/** "No Sauce", "Light Cheese": instructions, never a counted portion. */
export function isInstructionChoice(choice: { name: string }) {
  return /^(no|light|lite)\b/i.test(choice.name.trim());
}

/**
 * The included-portions rule for a group on the chosen size: that size's own
 * rule, else the "any size" one (mirrors wayne_group_size_rule_id).
 */
export function groupSizeRule(group: { size_rules?: SizeRule[] }, variantName: string | null | undefined): SizeRule | null {
  const rules = group.size_rules ?? [];
  if (!rules.length) return null;
  const name = (variantName ?? "").trim().toLowerCase();
  return (name ? rules.find((rule) => rule.variant_name.trim().toLowerCase() === name) : undefined)
    ?? rules.find((rule) => rule.variant_name.trim() === "") ?? null;
}

/** The most portions this group takes on this size. */
export function groupMaxPortions(group: { max_select: number }, rule: SizeRule | null) {
  return rule?.max_portions ?? group.max_select;
}

export type AllowanceLine = { choice_id: string; portions: number; free: number; unit_cents: number; charge_cents: number };

/**
 * How the picks in a rule group are charged (mirrors
 * wayne_group_allowance_lines): the first N portions are free, any mix and
 * repeats allowed, given to the dearest picks first; each one after that costs
 * the rule's extra price (or the option's own price when none is set).
 */
export function groupAllowanceLines(group: RuledGroup, rule: SizeRule, variantId: string | null | undefined, selected: { choice_id: string; quantity: number }[]): AllowanceLine[] {
  const picks = selected.flatMap((pick) => {
    const choice = group.choices.find((candidate) => candidate.id === pick.choice_id);
    return choice && pick.quantity > 0 ? [{ choice, quantity: pick.quantity, unit: choicePriceDeltaCents(choice, variantId) }] : [];
  }).sort((a, b) => (b.unit - a.unit) || (a.choice.id < b.choice.id ? -1 : a.choice.id > b.choice.id ? 1 : 0));
  let freeLeft = rule.included_count;
  return picks.map(({ choice, quantity, unit }) => {
    if (isInstructionChoice(choice) || isExtraChoice(choice)) return { choice_id: choice.id, portions: quantity, free: 0, unit_cents: unit, charge_cents: unit * quantity };
    const free = Math.min(quantity, freeLeft);
    freeLeft -= free;
    const each = rule.extra_each_cents ?? unit;
    return { choice_id: choice.id, portions: quantity, free, unit_cents: each, charge_cents: (quantity - free) * each };
  });
}

/** Portions picked in a group toward the free ones, not counting "No …" / "Light …" / "Extra …". */
export function countedPortions(group: { choices: ChoiceLike[] }, counts: Record<string, number>) {
  return group.choices.reduce((total, choice) => total + (isInstructionChoice(choice) || isExtraChoice(choice) ? 0 : counts[choice.id] ?? 0), 0);
}

export function cartLineUnitCents(menu: PublicMenu, line: CartLine) {
  if (line.open_item) return line.open_item.price_cents;
  const item = findMenuItem(menu, line.menu_item_id);
  if (!item) return 0;
  const variant = item.variants.find(
    (candidate) => candidate.id === line.variant_id,
  );
  const base = variant?.price_cents ?? item.base_price_cents;
  const counted = new Set<string>();
  let modifiers = 0;
  for (const group of item.modifier_groups) {
    const picks = line.modifiers.filter((selected) => !counted.has(selected.choice_id) && group.choices.some((choice) => choice.id === selected.choice_id));
    if (!picks.length) continue;
    for (const pick of picks) counted.add(pick.choice_id);
    const rule = groupSizeRule(group, variant?.name);
    if (rule) {
      modifiers += groupAllowanceLines(group, rule, line.variant_id, picks).reduce((sum, entry) => sum + entry.charge_cents, 0);
      continue;
    }
    for (const pick of picks) {
      const choice = group.choices.find((candidate) => candidate.id === pick.choice_id)!;
      modifiers += choicePriceDeltaCents(choice, line.variant_id) * chargedPortions(choice, pick.quantity);
    }
  }
  return base + modifiers;
}

export function cartSubtotalCents(menu: PublicMenu, lines: CartLine[]) {
  return lines.reduce(
    (sum, line) => sum + cartLineUnitCents(menu, line) * line.quantity,
    0,
  );
}
