import { describe, expect, it } from "vitest";
import {
  cartLineUnitCents,
  cartSubtotalCents,
  choicePriceDeltaCents,
  readCart,
} from "./cart";
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
                variant_prices: [],
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
  it("prefers a per-size modifier price override over the flat price", () => {
    const smallId = crypto.randomUUID();
    const largeId = crypto.randomUUID();
    const choiceId = crypto.randomUUID();
    const sizedMenu = [
      {
        id: crypto.randomUUID(),
        name: "Pizza",
        description: "",
        image_path: null,
        image_alt: "",
        items: [
          {
            id: crypto.randomUUID(),
            name: "One Topping",
            description: "",
            image_path: null,
            image_alt: "",
            base_price_cents: 0,
            included_count_label: "",
            sold_out: false,
            featured: false,
            available_days: [0, 1, 2, 3, 4, 5, 6],
            available_start: null,
            available_end: null,
            variants: [
              { id: smallId, name: "Small", price_cents: 950, sku: "", sort_order: 0 },
              { id: largeId, name: "Large", price_cents: 1425, sku: "", sort_order: 1 },
            ],
            modifier_groups: [
              {
                id: crypto.randomUUID(),
                name: "Toppings",
                customer_label: "Choose your topping",
                min_select: 1,
                max_select: 1,
                required: true,
                allow_quantities: false,
                choices: [
                  {
                    id: choiceId,
                    name: "Mushrooms",
                    price_delta_cents: 100,
                    default_selected: false,
                    // Small is $1, Large is $2 -- the exact Wayne's Thrive pricing.
                    variant_prices: [
                      { variant_id: smallId, price_delta_cents: 100 },
                      { variant_id: largeId, price_delta_cents: 200 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ] satisfies PublicMenu;
    const smallLine = {
      line_id: "line-small",
      menu_item_id: sizedMenu[0].items[0].id,
      variant_id: smallId,
      quantity: 1,
      special_instructions: "",
      modifiers: [{ choice_id: choiceId, quantity: 1 }],
    };
    const largeLine = { ...smallLine, line_id: "line-large", variant_id: largeId };
    expect(cartLineUnitCents(sizedMenu, smallLine)).toBe(950 + 100);
    expect(cartLineUnitCents(sizedMenu, largeLine)).toBe(1425 + 200);
  });
});

describe("modifier pricing by size", () => {
  const small = crypto.randomUUID();
  const large = crypto.randomUUID();
  const topping = {
    price_delta_cents: 200,
    variant_prices: [
      { variant_id: small, price_delta_cents: 100 },
      { variant_id: large, price_delta_cents: 200 },
    ],
  };

  it("charges the price of the size that was chosen", () => {
    expect(choicePriceDeltaCents(topping, small)).toBe(100);
    expect(choicePriceDeltaCents(topping, large)).toBe(200);
  });

  it("falls back to the flat price for a size with no price of its own", () => {
    const glutenFree = crypto.randomUUID();
    expect(choicePriceDeltaCents(topping, glutenFree)).toBe(200);
    expect(choicePriceDeltaCents(topping, null)).toBe(200);
  });

  it("subtracts when taking something off costs less, not more", () => {
    // "No Cheese" is free; a size may go further and take money off.
    const noCheese = {
      price_delta_cents: 0,
      variant_prices: [{ variant_id: large, price_delta_cents: -150 }],
    };
    expect(choicePriceDeltaCents(noCheese, small)).toBe(0);
    expect(choicePriceDeltaCents(noCheese, large)).toBe(-150);
  });
});
