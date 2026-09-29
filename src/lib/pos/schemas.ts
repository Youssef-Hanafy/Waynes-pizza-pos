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
  tip_cents: z.number().int().min(0).max(1_000_000),
  special_instructions: z.string().trim().max(1500),
  items: z.array(orderLineSchema).min(1).max(50),
}).superRefine((value, context) => {
  // A phone caller who does not want a profile is still a phone order, but
  // without an address on file it can only be picked up.
  if (value.customer_mode === "walk_in" && value.fulfillment_type !== "pickup") {
    context.addIssue({ code: "custom", message: "Orders without a customer profile must be pickup orders.", path: ["fulfillment_type"] });
  }
  if (value.customer_mode === "identified") {
    if (!value.first_name || !value.last_name || value.phone.length < 10) context.addIssue({ code: "custom", message: "Customer name and phone are required.", path: ["phone"] });
  }
  if (value.fulfillment_type === "delivery" && !value.address_id && (!value.address.address1 || !value.address.city || !value.address.state || !value.address.postal_code)) {
    context.addIssue({ code: "custom", message: "Complete or select a delivery address.", path: ["address"] });
  }
  if (value.promo_code && value.manual_discount_type) context.addIssue({ code: "custom", message: "Use a promotion or a manual discount, not both.", path: ["promo_code"] });
  if (value.manual_discount_type && (!value.manual_discount_value || value.manual_discount_reason.length < 3)) context.addIssue({ code: "custom", message: "Manual discounts require a value and reason.", path: ["manual_discount_reason"] });
});

export const posOrderCreatedSchema = z.object({
  id: z.uuid(),
  order_number: z.string(),
  total_cents: z.number().int(),
  duplicate: z.boolean(),
});

/** Create or update a customer from the POS (§8 "Create customer + start order"). */
export const posSaveCustomerSchema = z.object({
  customer_id: optionalUuid.optional().default(""),
  first_name: z.string().trim().min(1, "First name is required.").max(100),
  last_name: z.string().trim().min(1, "Last name is required.").max(100),
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
