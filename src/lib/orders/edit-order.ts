import type { PublicMenu } from "@/lib/menu/schemas";
import type { PosOrderLines } from "@/lib/pos/schemas";
import { uuid } from "@/lib/uuid";
import { findMenuItem, isIncludedChoice } from "./cart";
import { cartLineSchema, OPEN_ITEM_ID, type CartLine } from "./schemas";

/**
 * Editing an order already sent (owner, 2026-10-24: tap the order card, "it
 * brings the original items up, and you can click on them and edit them or
 * add new items").
 *
 * Each original line comes back as it was rung up (order_items.pos_line), so
 * opening it shows exactly the size and options picked.  Lines rung up before
 * that was kept are rebuilt from what printed on the slip; the item box shows
 * every option, so the cashier sees and confirms them before saving.
 */
export type ExistingLine = {
  id: string;
  name: string;
  variant: string | null;
  quantity: number;
  /** One of this line, options included, as charged. */
  unitCents: number;
  /** What printed under it ("NO Onion", "LEFT ½ Pepperoni"…). */
  modifiers: string[];
  instructions: string;
  /** The line to open in the item box, or null when the item is no longer on the menu. */
  line: CartLine | null;
};

export function existingLinesFrom(menu: PublicMenu, lines: PosOrderLines["lines"]): ExistingLine[] {
  return lines.map((source) => ({
    id: source.id,
    name: source.name,
    variant: source.variant,
    quantity: source.quantity,
    unitCents: source.unit_price_cents + source.modifier_unit_total_cents,
    modifiers: source.modifiers.map((modifier) => `${modifier.name}${modifier.quantity > 1 && !/\(\d+ included/.test(modifier.name) ? ` ×${modifier.quantity}` : ""}`),
    instructions: source.instructions,
    line: cartLineFor(menu, source),
  }));
}

export function cartLineFor(menu: PublicMenu, source: PosOrderLines["lines"][number]): CartLine | null {
  // An open item (misc charge): its name and price.
  if (!source.menu_item_id) {
    const parsed = cartLineSchema.safeParse({
      line_id: uuid(), menu_item_id: OPEN_ITEM_ID, variant_id: null, quantity: source.quantity, special_instructions: source.instructions,
      modifiers: [], open_item: { name: source.name.slice(0, 80), price_cents: source.unit_price_cents },
    });
    return parsed.success ? parsed.data : null;
  }
  const item = findMenuItem(menu, source.menu_item_id);
  if (!item) return null;
  // Rung up on this POS since 2026-10-24: exactly as it was.
  if (source.pos_line) {
    const parsed = cartLineSchema.safeParse({ ...source.pos_line, line_id: uuid(), quantity: source.quantity, special_instructions: source.instructions });
    if (parsed.success && parsed.data.menu_item_id === item.id) return parsed.data;
  }
  // Older lines: rebuilt from the printed options.
  const choices = new Map(item.modifier_groups.flatMap((group) => group.choices.map((choice) => [choice.id, choice] as const)));
  const removed = new Set(source.modifiers.filter((modifier) => /^NO /i.test(modifier.name) && modifier.choice_id).map((modifier) => modifier.choice_id!));
  const picked = new Map<string, { quantity: number; placement?: "left" | "right" }>();
  for (const choice of choices.values()) if (isIncludedChoice(choice) && !removed.has(choice.id)) picked.set(choice.id, { quantity: 1 });
  for (const modifier of source.modifiers) {
    if (!modifier.choice_id || /^NO /i.test(modifier.name) || !choices.has(modifier.choice_id)) continue;
    const choice = choices.get(modifier.choice_id)!;
    const placement = modifier.placement === "left" || modifier.placement === "right" ? modifier.placement : undefined;
    // An included option printed as "Extra …" was charged for the portions on top of the one it comes with.
    const quantity = isIncludedChoice(choice) && /^Extra /i.test(modifier.name) ? modifier.quantity + 1 : Math.max(1, modifier.quantity);
    picked.set(modifier.choice_id, { quantity: Math.min(20, quantity), ...(placement ? { placement } : {}) });
  }
  const parsed = cartLineSchema.safeParse({
    line_id: uuid(), menu_item_id: item.id, variant_id: source.variant_id, quantity: source.quantity, special_instructions: source.instructions,
    modifiers: [...picked.entries()].map(([choice_id, value]) => ({ choice_id, ...value })),
  });
  return parsed.success ? parsed.data : null;
}
