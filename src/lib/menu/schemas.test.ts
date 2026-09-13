import { describe, expect, it } from "vitest";
import {
  formatCents,
  menuItemPayloadSchema,
  parseMoneyToCents,
  parseSignedMoneyToCents,
  variantSchema,
} from "./schemas";

describe("menu validation", () => {
  it.each([
    ["12.99", 1299],
    ["0", 0],
    ["4.5", 450],
  ])("converts %s to integer cents", (input, output) => {
    expect(parseMoneyToCents(input)).toBe(output);
  });
  it.each(["1.999", "-1", "free", ""])("rejects invalid money %s", (input) => {
    expect(parseMoneyToCents(input)).toBeNull();
  });
  it.each([
    ["1.50", 150],
    ["-0.75", -75],
    ["0", 0],
  ])("converts signed price delta %s", (input, output) => {
    expect(parseSignedMoneyToCents(input)).toBe(output);
  });
  it.each(["--1", "1.999", "free", ""])(
    "rejects invalid signed price delta %s",
    (input) => {
      expect(parseSignedMoneyToCents(input)).toBeNull();
    },
  );
  it("formats cents for display", () => {
    expect(formatCents(1299)).toBe("$12.99");
  });
  it("rejects invalid modifier selection bounds", () => {
    const result = menuItemPayloadSchema.safeParse({
      category_id: crypto.randomUUID(),
      name: "Pizza",
      description: "",
      image_path: null,
      image_alt: "",
      base_price_cents: 1000,
      tax_category: "prepared_food",
      included_count_label: "",
      sold_out: false,
      customer_visible: true,
      pos_visible: true,
      featured: false,
      kitchen_route: "",
      available_days: [1],
      available_start: "",
      available_end: "",
      sort_order: 0,
      variants: [],
      modifier_groups: [
        {
          name: "Toppings",
          customer_label: "Pick",
          min_select: 2,
          max_select: 1,
          required: true,
          allow_quantities: false,
          choices: [
            { name: "Cheese", price_delta_cents: 0, default_selected: true },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("variant SKUs", () => {
  it("accepts the null the database sends for a variant with no SKU", () => {
    // This is what took the POS down: every seeded variant has a null sku, the
    // RPC passes it through, and a schema that only allowed string | undefined
    // threw on the whole menu.
    const parsed = variantSchema.safeParse({ id: "7b1f0f3c-2c9e-4a1b-9f11-2b3c4d5e6f70", name: "Large", price_cents: 1225, sku: null, sort_order: 10 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.sku).toBe("");
  });

  it("still accepts a real SKU and an absent one", () => {
    expect(variantSchema.safeParse({ name: "Small", price_cents: 825, sku: "PZ-SM" }).success).toBe(true);
    const absent = variantSchema.safeParse({ name: "Small", price_cents: 825 });
    expect(absent.success && absent.data.sku).toBe("");
  });
});
