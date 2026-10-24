import { z } from "zod";
import { orderLineSchema } from "@/lib/orders/schemas";

export const posCustomerAddressSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  address1: z.string(),
  address2: z.string(),
  city: z.string(),
  state: z.string(),
  postal_code: z.string(),
  delivery_instructions: z.string(),
  is_default: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const posCustomerSchema = z.object({
  id: z.uuid(),
  first_name: z.string(),
  last_name: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  first_order_at: z.string().nullable(),
  last_order_at: z.string().nullable(),
  order_count: z.number().int().nonnegative(),
  lifetime_spend_cents: z.number().int().nonnegative(),
  average_order_value_cents: z.number().int().nonnegative(),
  notes: z.string().nullable().optional().transform((value) => value ?? ""),
  /** Extra numbers the customer calls from (the primary one is `phone`). */
  phones: z.array(z.object({ phone: z.string(), label: z.string() })).optional().transform((value) => value ?? []),
  addresses: z.array(posCustomerAddressSchema),
});

const optionalUuid = z.union([z.literal(""), z.uuid()]);

export const posOrderInputSchema = z.object({
  idempotency_key: z.string().min(16).max(160),
  customer_mode: z.enum(["walk_in", "identified"]),
  customer_id: optionalUuid,
  source: z.enum(["pos", "phone"]),
  /** The ring this order came from, and the physical line it rang on (§11). */
  phone_call_id: optionalUuid.optional().default(""),
  phone_line: z.number().int().min(1).max(8).nullable().optional().default(null),
  fulfillment_type: z.enum(["pickup", "delivery"]),
  payment_method: z.enum(["test_manual", "cash"]),
  /** A practice ticket: kept out of sales, the drawer count and the CRM. */
  is_test: z.boolean().optional().default(false),
  first_name: z.string().trim().max(100),
  last_name: z.string().trim().max(100),
  phone: z.string().trim().max(40),
  email: z.union([z.literal(""), z.email()]),
  address_id: optionalUuid,
  address: z.object({
    address1: z.string().trim().max(200),
    address2: z.string().trim().max(200),
    city: z.string().trim().max(120),
    state: z.string().trim().max(80),
    postal_code: z.string().trim().max(20),
    delivery_instructions: z.string().trim().max(1000),
  }),
  promo_code: z.string().trim().max(40),
  manual_discount_type: z.enum(["", "fixed", "percent"]),
  manual_discount_value: z.number().int().min(0).max(1_000_000),
  manual_discount_reason: z.string().trim().max(500),
  /** A discount saved in Admin → Discounts (any cashier may use it; the database sets the amount). */
  pos_discount_id: optionalUuid.optional().default(""),
  tip_cents: z.number().int().min(0).max(1_000_000),
  special_instructions: z.string().trim().max(1500),
  items: z.array(orderLineSchema).min(1).max(50),
  /**
   * Taken while the register was offline (owner, 2026-10-24) and sent when the
   * connection came back: the counter already printed its kitchen ticket, so
   * the server never prints it again.  Only an offline order sends these.
   */
  offline_printed: z.boolean().optional().default(false),
  offline_taken_at: z.union([z.literal(""), z.iso.datetime({ offset: true })]).optional().default(""),
  offline_local_number: z.string().trim().max(20).optional().default(""),
}).superRefine((value, context) => {
  // A phone caller who does not want a profile is still a phone order, but
  // without an address on file it can only be picked up.
  if (value.customer_mode === "walk_in" && value.fulfillment_type !== "pickup") {
    context.addIssue({ code: "custom", message: "Orders without a customer profile must be pickup orders.", path: ["fulfillment_type"] });
  }
  // Nothing about the customer is required (rush orders, owner 2026-10-11),
  // but a phone that was typed has to be a real number.
  const digits = value.phone.replace(/\D/g, "");
  if (value.customer_mode === "identified" && digits.length > 0 && !(digits.length === 10 || (digits.length === 11 && digits.startsWith("1")))) {
    context.addIssue({ code: "custom", message: "Enter a 10-digit phone number, or leave the phone blank.", path: ["phone"] });
  }
  if (value.fulfillment_type === "delivery" && !value.address_id && !value.address.address1) {
    context.addIssue({ code: "custom", message: "Enter the street address for the delivery.", path: ["address"] });
  }
  if (value.promo_code && value.manual_discount_type) context.addIssue({ code: "custom", message: "Use a promotion or a manual discount, not both.", path: ["promo_code"] });
  if (value.manual_discount_type && !value.pos_discount_id && (!value.manual_discount_value || value.manual_discount_reason.length < 3)) context.addIssue({ code: "custom", message: "Manual discounts require a value and reason.", path: ["manual_discount_reason"] });
});

export const posOrderCreatedSchema = z.object({
  id: z.uuid(),
  order_number: z.string(),
  /** The day's ticket number (#1, #2 …). */
  daily_number: z.number().int().nullable().optional().default(null),
  total_cents: z.number().int(),
  duplicate: z.boolean(),
});

/**
 * Items added to an order already sent (Today's Orders → Add items, owner
 * 2026-10-13).  Same ticket lines as a new order.
 */
export const posAddItemsInputSchema = z.object({
  idempotency_key: z.string().min(16).max(160),
  special_instructions: z.string().max(500).default(""),
  items: z.array(orderLineSchema).min(1).max(50),
});
export type PosAddItemsInput = z.infer<typeof posAddItemsInputSchema>;

/**
 * Edit an order (owner, 2026-10-24: tap the order card, the original items come
 * up, edit them or add new ones — same order, no new slip).  Lines taken off
 * (or replaced by an edited copy), quantities changed, and new lines.
 */
export const posEditItemsInputSchema = z.object({
  idempotency_key: z.string().min(16).max(160),
  special_instructions: z.string().max(500).default(""),
  remove_item_ids: z.array(z.uuid()).max(100).default([]),
  quantities: z.array(z.object({ id: z.uuid(), quantity: z.number().int().min(1).max(20) })).max(100).default([]),
  items: z.array(orderLineSchema).max(50).default([]),
}).refine((value) => value.remove_item_ids.length || value.quantities.length || value.items.length || value.special_instructions.trim(), { message: "Nothing was changed." });
export type PosEditItemsInput = z.infer<typeof posEditItemsInputSchema>;

/** An order's lines, as the POS editor opens them (wayne_pos_order_lines). */
export const posOrderLinesSchema = z.object({
  order: z.object({
    id: z.uuid(), order_number: z.string(), daily_number: z.number().int().nullable(), customer_name: z.string().nullable().transform((value) => value ?? ""),
    fulfillment_type: z.string(), status: z.string(), payment_status: z.string(), total_cents: z.number().int(), paid_cents: z.number().int(),
    discount_cents: z.number().int(), source: z.string(), placed_at: z.string().nullable(),
  }),
  lines: z.array(z.object({
    id: z.uuid(), menu_item_id: z.uuid().nullable(), variant_id: z.uuid().nullable(), name: z.string(), variant: z.string().nullable(),
    quantity: z.number().int(), unit_price_cents: z.number().int(), modifier_unit_total_cents: z.number().int(), line_total_cents: z.number().int(),
    instructions: z.string().nullable().transform((value) => value ?? ""), pos_line: z.record(z.string(), z.unknown()).nullable(),
    modifiers: z.array(z.object({ choice_id: z.uuid().nullable(), name: z.string(), quantity: z.number().int(), placement: z.string().nullable() })),
  })),
});
export type PosOrderLines = z.infer<typeof posOrderLinesSchema>;

/**
 * The items are always on the same order (owner, 2026-10-19).  paid_cents is
 * what was already paid; the rest is taken on the payment screen.  ("add_on"
 * only comes back from add-ons made before then.)
 */
export const posItemsAddedSchema = z.object({
  order_id: z.uuid(),
  mode: z.enum(["merged", "add_on"]),
  order_number: z.string(),
  daily_number: z.number().int().nullable().optional().default(null),
  total_cents: z.number().int(),
  added_cents: z.number().int().optional().default(0),
  paid_cents: z.number().int().optional().default(0),
  parent_order_id: z.uuid().nullable().optional().default(null),
  duplicate: z.boolean().optional().default(false),
});
export type PosItemsAdded = z.infer<typeof posItemsAddedSchema>;

/** Create or update a customer from the POS (§8 "Create customer + start order"). */
export const posSaveCustomerSchema = z.object({
  customer_id: optionalUuid.optional().default(""),
  first_name: z.string().trim().max(100).optional().default(""),
  last_name: z.string().trim().max(100).optional().default(""),
  phone: z.string().trim().min(10, "Enter a 10-digit phone number.").max(40),
  email: z.union([z.literal(""), z.email("Enter a valid email address.")]).optional().default(""),
  extra_phone: z.string().trim().max(40).optional().default(""),
  extra_phone_label: z.string().trim().max(40).optional().default(""),
  address: z.object({
    address1: z.string().trim().max(200),
    address2: z.string().trim().max(200),
    city: z.string().trim().max(120),
    state: z.string().trim().max(80),
    postal_code: z.string().trim().max(20),
    delivery_instructions: z.string().trim().max(1000),
  }).optional(),
});

export const posCustomerOrderSchema = z.object({
  id: z.uuid(),
  order_number: z.string(),
  placed_at: z.string(),
  status: z.string(),
  source: z.string(),
  fulfillment_type: z.string(),
  total_cents: z.number().int(),
  phone_line: z.number().int().nullable(),
  items: z.string(),
});

export type PosCustomer = z.infer<typeof posCustomerSchema>;
export type PosCustomerOrder = z.infer<typeof posCustomerOrderSchema>;
export type PosSaveCustomer = z.input<typeof posSaveCustomerSchema>;
export type PosOrderInput = z.infer<typeof posOrderInputSchema>;
