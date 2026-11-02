import { z } from "zod";

export const fulfillmentAddressSchema = z.object({
  address1: z.string().trim().max(200), address2: z.string().trim().max(200).default(""),
  city: z.string().trim().max(120), state: z.string().trim().max(80), postal_code: z.string().trim().max(20).default(""),
  delivery_instructions: z.string().trim().max(1000).default(""),
});
export const changeFulfillmentSchema = z.object({
  idempotency_key: z.string().min(16).max(160),
  refund_cash: z.boolean().default(false), refund_shift_id: z.uuid().nullable().default(null),
  fulfillment_type: z.enum(["pickup", "delivery"]), expected_fulfillment_type: z.enum(["pickup", "delivery"]),
  expected_total_cents: z.number().int().nonnegative(),
  customer_name: z.string().trim().max(200), customer_phone: z.string().trim().max(40),
  delivery_address: fulfillmentAddressSchema.nullable(),
}).superRefine((value, context) => {
  if (value.fulfillment_type !== "delivery") return;
  if (!value.customer_name || value.customer_phone.replace(/\D/g, "").length < 10) context.addIssue({ code: "custom", message: "Enter the customer name and phone number for delivery." });
  if (!value.delivery_address?.address1 || !value.delivery_address.city || !value.delivery_address.state) context.addIssue({ code: "custom", message: "Enter a street address, city and state for delivery." });
});
export const fulfillmentChangedSchema = z.object({
  order_id: z.uuid(), fulfillment_type: z.enum(["pickup", "delivery"]), delivery_address: fulfillmentAddressSchema.nullable(),
  delivery_fee_cents: z.number().int(), total_cents: z.number().int(), payment_status: z.string(), duplicate: z.boolean(),
});
export type FulfillmentChanged = z.infer<typeof fulfillmentChangedSchema>;
