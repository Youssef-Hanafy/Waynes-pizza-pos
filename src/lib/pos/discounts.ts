import { z } from "zod";

/**
 * Discounts saved in Admin → Discounts (owner, 2026-10-19).  They show as
 * buttons in the POS Discount box.  fixed = cents off; percent = basis points
 * (10% = 1000), the same units as a manual discount.
 */
export const posDiscountSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  discount_type: z.enum(["fixed", "percent"]),
  discount_value: z.number().int().positive(),
});
export type PosDiscount = z.infer<typeof posDiscountSchema>;

export const adminPosDiscountSchema = posDiscountSchema.extend({
  active: z.boolean(),
  sort_order: z.number().int(),
  times_used: z.number().int().optional().default(0),
});
export type AdminPosDiscount = z.infer<typeof adminPosDiscountSchema>;

/** "$5.00 off" / "10% off" */
export function discountLabel(discount: Pick<PosDiscount, "discount_type" | "discount_value">) {
  return discount.discount_type === "percent"
    ? `${Number((discount.discount_value / 100).toFixed(2))}% off`
    : `$${(discount.discount_value / 100).toFixed(2)} off`;
}

/** The value the ticket's discount field holds: dollars for fixed, percent for percent. */
export function discountInputValue(discount: Pick<PosDiscount, "discount_type" | "discount_value">) {
  return String(Number((discount.discount_value / 100).toFixed(2)));
}
