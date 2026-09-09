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
    line.modifiers.reduce(
      (sum, selected) =>
        sum +
        (choices.find((choice) => choice.id === selected.choice_id)
          ?.price_delta_cents ?? 0) *
          selected.quantity,
      0,
    )
  );
}

export function cartSubtotalCents(menu: PublicMenu, lines: CartLine[]) {
  return lines.reduce(
    (sum, line) => sum + cartLineUnitCents(menu, line) * line.quantity,
    0,
  );
}
