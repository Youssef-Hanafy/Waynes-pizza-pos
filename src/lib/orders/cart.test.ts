import { describe, expect, it } from "vitest";
import { cartLineUnitCents, cartSubtotalCents, readCart } from "./cart";
import type { PublicMenu } from "@/lib/menu/schemas";

const menu = [
  {
    id: crypto.randomUUID(),
    name: "Pizza",
    description: "",
    image_path: null,
    image_alt: "",
    items: [
      {
        id: crypto.randomUUID(),
        name: "Classic",
        description: "",
        image_path: null,
        image_alt: "",
        base_price_cents: 1000,
        included_count_label: "",
        sold_out: false,
        featured: false,
        available_days: [0, 1, 2, 3, 4, 5, 6],
        available_start: null,
        available_end: null,
        variants: [
          {
            id: crypto.randomUUID(),
            name: "Large",
            price_cents: 1500,
            sku: "",
            sort_order: 0,
          },
        ],
        modifier_groups: [
          {
            id: crypto.randomUUID(),
            name: "Toppings",
            customer_label: "Toppings",
            min_select: 0,
            max_select: 3,
            required: false,
            allow_quantities: true,
            choices: [
              {
                id: crypto.randomUUID(),
                name: "Pepperoni",
                price_delta_cents: 200,
                default_selected: false,
              },
            ],
          },
        ],
      },
    ],
  },
] satisfies PublicMenu;
const item = menu[0].items[0];
const line = {
  line_id: "line-1",
  menu_item_id: item.id,
  variant_id: item.variants[0].id,
  quantity: 2,
  special_instructions: "",
  modifiers: [
    { choice_id: item.modifier_groups[0].choices[0].id, quantity: 2 },
  ],
};

describe("cart", () => {
  it("calculates variant and modifier quantities in integer cents", () => {
    expect(cartLineUnitCents(menu, line)).toBe(1900);
    expect(cartSubtotalCents(menu, [line])).toBe(3800);
  });
  it("rejects corrupt persisted cart data", () => {
    expect(readCart("not-json")).toEqual([]);
    expect(readCart(JSON.stringify([{ bad: true }]))).toEqual([]);
  });
});
