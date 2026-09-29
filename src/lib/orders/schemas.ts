import { z } from "zod";

export const cartModifierSchema = z.object({
  choice_id: z.uuid(),
  quantity: z.number().int().min(1).max(20),
});

export const cartLineSchema = z.object({
  line_id: z.string().min(1).max(100),
  menu_item_id: z.uuid(),
  variant_id: z.uuid().nullable(),
  quantity: z.number().int().min(1).max(20),
  special_instructions: z.string().trim().max(500),
  modifiers: z.array(cartModifierSchema).max(100),
});

// What an order screen sends for one line.  `lists_included` says the screen
// pre-selects what the item comes with, so an included option missing from
// `modifiers` was taken off on purpose and prints as "NO <option>".  Screens
// built before that (and old saved carts) send false and never print a NO.
export const orderLineSchema = cartLineSchema.omit({ line_id: true }).extend({
  lists_included: z.boolean().default(false),
});

export const checkoutInputSchema = z
  .object({
    idempotency_key: z.string().min(16).max(160),
    fulfillment_type: z.enum(["pickup", "delivery"]),
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().min(1).max(100),
    phone: z.string().trim().min(10).max(40),
    email: z.union([z.literal(""), z.email()]),
    sms_opt_in: z.boolean(),
    email_opt_in: z.boolean(),
    tip_cents: z.number().int().min(0).max(1_000_000),
    promo_code: z.string().trim().max(40),
    special_instructions: z.string().trim().max(1500),
    address: z.object({
      address1: z.string().trim().max(200),
      address2: z.string().trim().max(200),
      city: z.string().trim().max(120),
      state: z.string().trim().max(80),
      postal_code: z.string().trim().max(20),
      delivery_instructions: z.string().trim().max(1000),
    }),
    items: z.array(orderLineSchema).min(1).max(50),
  })
  .superRefine((value, context) => {
    if (value.fulfillment_type === "delivery") {
      for (const field of [
        "address1",
        "city",
        "state",
        "postal_code",
      ] as const) {
        if (!value.address[field])
          context.addIssue({
            code: "custom",
            message: "Complete the delivery address.",
            path: ["address", field],
          });
      }
    }
  });

export const orderCreatedSchema = z.object({
  id: z.uuid(),
  public_access_token: z.uuid(),
  order_number: z.string(),
  total_cents: z.number().int(),
  duplicate: z.boolean(),
});

const orderStatusItemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  variant_name: z.string().nullable(),
  unit_price_cents: z.number().int(),
  modifier_unit_total_cents: z.number().int(),
  quantity: z.number().int(),
  line_total_cents: z.number().int(),
  special_instructions: z.string(),
  modifiers: z.array(
    z.object({
      group_name: z.string(),
      name: z.string(),
      price_delta_cents: z.number().int(),
      quantity: z.number().int(),
    }),
  ),
});

export const publicOrderStatusSchema = z.object({
  id: z.uuid(),
  order_number: z.string(),
  fulfillment_type: z.enum(["pickup", "delivery"]),
  status: z.string(),
  payment_status: z.string(),
  payment_method: z.string(),
  subtotal_cents: z.number().int(),
  discount_cents: z.number().int(),
  delivery_fee_cents: z.number().int(),
  tax_cents: z.number().int(),
  tip_cents: z.number().int(),
  total_cents: z.number().int(),
  customer_name: z.string(),
  customer_phone: z.string(),
  customer_email: z.string().nullable(),
  delivery_address: z.record(z.string(), z.unknown()).nullable(),
  special_instructions: z.string(),
  placed_at: z.string(),
  promised_at: z.string().nullable(),
  items: z.array(orderStatusItemSchema),
});

export type CartLine = z.infer<typeof cartLineSchema>;
export type CheckoutInput = z.infer<typeof checkoutInputSchema>;
export type PublicOrderStatus = z.infer<typeof publicOrderStatusSchema>;
