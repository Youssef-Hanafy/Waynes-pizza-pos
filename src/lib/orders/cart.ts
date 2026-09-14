import type { PublicMenu } from "@/lib/menu/schemas";
import { cartLineSchema, type CartLine } from "./schemas";

export const CART_STORAGE_KEY = "wayne-cart-v1";

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
      return sum + choicePriceDeltaCents(choice, line.variant_id) * selected.quantity;
    }, 0)
  );
}

export function cartSubtotalCents(menu: PublicMenu, lines: CartLine[]) {
  return lines.reduce(
    (sum, line) => sum + cartLineUnitCents(menu, line) * line.quantity,
    0,
  );
}
