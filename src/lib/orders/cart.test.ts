import { describe, expect, it } from "vitest";
import {
  cartLineUnitCents,
  cartSubtotalCents,
  choiceAllowsExtra,
  choicePriceDeltaCents,
  describeLineModifiers,
  groupAllowanceLines,
  groupSizeRule,
  includedSelection,
  readCart,
} from "./cart";
import type { PublicMenu } from "@/lib/menu/schemas";
import { OPEN_ITEM_ID } from "./schemas";

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
            size_rules: [],
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
                size_rules: [],
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

describe("toppings an item comes with", () => {
  const pepperoni = { id: crypto.randomUUID(), name: "Pepperoni", price_delta_cents: 200, default_selected: true, variant_prices: [] };
  const salami = { id: crypto.randomUUID(), name: "Salami", price_delta_cents: 200, default_selected: true, variant_prices: [] };
  const mushrooms = { id: crypto.randomUUID(), name: "Mushrooms", price_delta_cents: 200, default_selected: false, variant_prices: [] };
  const meatLovers = {
    id: crypto.randomUUID(),
    name: "Meat Lovers",
    description: "Comes with: Pepperoni, Salami",
    image_path: null,
    image_alt: "",
    base_price_cents: 1300,
    included_count_label: "",
    sold_out: false,
    featured: false,
    available_days: [0, 1, 2, 3, 4, 5, 6],
    available_start: null,
    available_end: null,
    variants: [],
    modifier_groups: [
      { id: crypto.randomUUID(), name: "Meats", customer_label: "Meats", min_select: 0, max_select: 10, required: false, allow_quantities: true, size_rules: [], choices: [pepperoni, salami, mushrooms] },
    ],
  };
  const pizzaMenu = [{ id: crypto.randomUUID(), name: "Gourmet", description: "", image_path: null, image_alt: "", items: [meatLovers] }] satisfies PublicMenu;
  const base = { line_id: "l", menu_item_id: meatLovers.id, variant_id: null, quantity: 1, special_instructions: "" };

  it("starts with everything the item comes with already selected", () => {
    expect(includedSelection(meatLovers)).toEqual({ [pepperoni.id]: 1, [salami.id]: 1 });
  });

  it("does not charge for what the item comes with, or credit it when removed", () => {
    expect(cartLineUnitCents(pizzaMenu, { ...base, modifiers: [{ choice_id: pepperoni.id, quantity: 1 }, { choice_id: salami.id, quantity: 1 }] })).toBe(1300);
    expect(cartLineUnitCents(pizzaMenu, { ...base, modifiers: [{ choice_id: pepperoni.id, quantity: 1 }] })).toBe(1300);
  });

  it("charges extra portions and added toppings", () => {
    expect(cartLineUnitCents(pizzaMenu, { ...base, modifiers: [{ choice_id: pepperoni.id, quantity: 2 }, { choice_id: salami.id, quantity: 1 }, { choice_id: mushrooms.id, quantity: 1 }] })).toBe(1700);
  });

  it("reads like a ticket: only what changed from the recipe", () => {
    const notes = describeLineModifiers(meatLovers, { modifiers: [{ choice_id: pepperoni.id, quantity: 2 }, { choice_id: mushrooms.id, quantity: 1 }] });
    expect(notes.map((note) => note.label)).toEqual(["NO Salami", "Extra Pepperoni", "Mushrooms"]);
    expect(describeLineModifiers(meatLovers, { modifiers: [{ choice_id: pepperoni.id, quantity: 1 }, { choice_id: salami.id, quantity: 1 }] })).toEqual([]);
  });

  it("says which half a topping is on, and charges a half the same as a whole (owner, 2026-10-20)", () => {
    const halves = describeLineModifiers(meatLovers, { modifiers: [
      { choice_id: pepperoni.id, quantity: 1, placement: "left" },
      { choice_id: salami.id, quantity: 2, placement: "right" },
      { choice_id: mushrooms.id, quantity: 1, placement: "left" },
    ] });
    expect(halves.map((note) => note.label)).toEqual(["LEFT ½ Pepperoni", "RIGHT ½ Salami", "RIGHT ½ Extra Salami", "LEFT ½ Mushrooms"]);
    const whole = { ...base, modifiers: [{ choice_id: pepperoni.id, quantity: 1 }, { choice_id: salami.id, quantity: 2 }, { choice_id: mushrooms.id, quantity: 1 }] };
    const sided = { ...base, modifiers: [{ choice_id: pepperoni.id, quantity: 1, placement: "left" as const }, { choice_id: salami.id, quantity: 2, placement: "right" as const }, { choice_id: mushrooms.id, quantity: 1, placement: "left" as const }] };
    expect(cartLineUnitCents(pizzaMenu, sided)).toBe(cartLineUnitCents(pizzaMenu, whole));
  });

  it("lets extra portions of a topping it comes with be added (Hawaiian: extra ham and pineapple)", () => {
    const meats = { allow_quantities: true };
    expect(choiceAllowsExtra(meats, { name: "Ham" })).toBe(true);
    expect(choiceAllowsExtra(meats, { name: "Pineapple" })).toBe(true);
    expect(choiceAllowsExtra(meats, { name: "No Cheese" })).toBe(false);
    expect(choiceAllowsExtra(meats, { name: "Light Cheese" })).toBe(false);
    expect(choiceAllowsExtra({ allow_quantities: false }, { name: "Ham" })).toBe(false);
  });
});

describe("included portions per size (a Large calzone comes with 3 sauces)", () => {
  const ranch = { id: "00000000-0000-4000-8000-0000000000a1", name: "Ranch", price_delta_cents: 75, default_selected: false, variant_prices: [] };
  const bbq = { id: "00000000-0000-4000-8000-0000000000a2", name: "BBQ", price_delta_cents: 75, default_selected: false, variant_prices: [] };
  const none = { id: "00000000-0000-4000-8000-0000000000a3", name: "No Sauce", price_delta_cents: 0, default_selected: false, variant_prices: [] };
  const small = { id: "00000000-0000-4000-8000-0000000000b1", name: "Small", price_cents: 1000, sku: "", sort_order: 0 };
  const large = { id: "00000000-0000-4000-8000-0000000000b2", name: "Large", price_cents: 1600, sku: "", sort_order: 1 };
  const sauces = {
    id: "00000000-0000-4000-8000-0000000000c1", name: "Calzone – Sauces", customer_label: "Sauces", min_select: 0, max_select: 5, required: false, allow_quantities: true,
    size_rules: [
      { variant_name: "Small", included_count: 1, max_portions: 3, extra_each_cents: 50 },
      { variant_name: "Large", included_count: 3, max_portions: 5, extra_each_cents: null },
    ],
    choices: [ranch, bbq, none],
  };
  const calzone = { id: "00000000-0000-4000-8000-0000000000d1", name: "Calzone", description: "", image_path: null, image_alt: "", base_price_cents: 1000, included_count_label: "", sold_out: false, featured: false, available_days: [0, 1, 2, 3, 4, 5, 6], available_start: null, available_end: null, variants: [small, large], modifier_groups: [sauces] };
  const calzoneMenu = [{ id: "00000000-0000-4000-8000-0000000000e1", name: "Calzones", description: "", image_path: null, image_alt: "", items: [calzone] }] as PublicMenu;
  const line = (variant_id: string, modifiers: { choice_id: string; quantity: number }[]) => ({ line_id: "l", menu_item_id: calzone.id, variant_id, quantity: 1, special_instructions: "", modifiers });

  it("picks the size's own rule", () => {
    expect(groupSizeRule(sauces, "large")?.included_count).toBe(3);
    expect(groupSizeRule(sauces, "Medium")).toBeNull();
  });

  it("2 Ranch + 1 BBQ on a Large are all free", () => {
    expect(cartLineUnitCents(calzoneMenu, line(large.id, [{ choice_id: ranch.id, quantity: 2 }, { choice_id: bbq.id, quantity: 1 }]))).toBe(1600);
  });

  it("each sauce after the free ones costs extra (option price when no extra price is set)", () => {
    expect(cartLineUnitCents(calzoneMenu, line(large.id, [{ choice_id: ranch.id, quantity: 3 }, { choice_id: bbq.id, quantity: 2 }]))).toBe(1600 + 2 * 75);
    expect(cartLineUnitCents(calzoneMenu, line(small.id, [{ choice_id: ranch.id, quantity: 2 }]))).toBe(1000 + 50);
  });

  it("No Sauce never uses up a free one", () => {
    const lines = groupAllowanceLines(sauces, sauces.size_rules[0]!, small.id, [{ choice_id: none.id, quantity: 1 }, { choice_id: ranch.id, quantity: 1 }]);
    expect(lines.find((entry) => entry.choice_id === ranch.id)?.free).toBe(1);
  });
});

describe("open items (owner, 2026-10-13)", () => {
  it("prices an open item at what the cashier typed, whatever the menu says", () => {
    const line = { line_id: "o", menu_item_id: OPEN_ITEM_ID, variant_id: null, quantity: 3, special_instructions: "", modifiers: [], open_item: { name: "Extra cup", price_cents: 150 } };
    expect(cartLineUnitCents([] as unknown as PublicMenu, line)).toBe(150);
    expect(cartSubtotalCents([] as unknown as PublicMenu, [line])).toBe(450);
  });
});
