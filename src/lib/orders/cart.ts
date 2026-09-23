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
    if (isIncludedChoice(choice)) {
      const extra = modifier.quantity - 1;
      if (extra > 0) notes.push({ kind: "extra", label: `${extra > 1 ? `${extra}× ` : ""}Extra ${choice.name}` });
    } else {
      notes.push({ kind: "added", label: `${modifier.quantity > 1 ? `${modifier.quantity}× ` : ""}${choice.name}` });
    }
  }
  return notes;
}

export function cartLineUnitCents(menu: PublicMenu, line: CartLine) {
  const item = findMenuItem(menu, line.menu_item_id);
  if (!item) return 0;
  const variant = item.variants.find(
    (candidate) => candidate.id === line.variant_id,
  );
  const base = variant?.price_cents ?? item.base_price_cents;
  const choices = item.modifier_groups.flatMap((group) => group.choices);
  return (
    base +
    line.modifiers.reduce((sum, selected) => {
      const choice = choices.find((candidate) => candidate.id === selected.choice_id);
      if (!choice) return sum;
      return sum + choicePriceDeltaCents(choice, line.variant_id) * chargedPortions(choice, selected.quantity);
    }, 0)
  );
}

export function cartSubtotalCents(menu: PublicMenu, lines: CartLine[]) {
  return lines.reduce(
    (sum, line) => sum + cartLineUnitCents(menu, line) * line.quantity,
    0,
  );
}
