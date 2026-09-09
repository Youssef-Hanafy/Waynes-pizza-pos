import { z } from "zod";

const fulfillmentSchema = z.enum(["pickup", "delivery"]);

export const adminOrderSummarySchema = z.object({
  id: z.uuid(),
  order_number: z.string(),
  customer_id: z.uuid().nullable(),
  customer_name_snapshot: z.string(),
  customer_phone_snapshot: z.string(),
  fulfillment_type: fulfillmentSchema,
  source: z.enum(["online", "pos", "phone", "admin"]),
  status: z.string(),
  payment_status: z.string(),
  payment_method: z.enum(["test_manual", "cash", "card"]),
  total_cents: z.number().int(),
  discount_cents: z.number().int(),
  placed_at: z.string().nullable(),
  promised_at: z.string().nullable(),
});

export const adminOrderSearchResultSchema = z.object({
  orders: z.array(adminOrderSummarySchema),
  total_count: z.number().int().nonnegative(),
});

export const adminCalendarDaySchema = z.object({
  service_date: z.string(),
  order_count: z.number().int().nonnegative(),
  active_total_cents: z.number().int().nonnegative(),
  pickup_count: z.number().int().nonnegative(),
  delivery_count: z.number().int().nonnegative(),
});

const adminOrderModifierSchema = z.object({
  id: z.uuid(),
  modifier_choice_id: z.uuid().nullable(),
  modifier_group_name_snapshot: z.string(),
  modifier_name_snapshot: z.string(),
  price_delta_cents: z.number().int(),
  quantity: z.number().int(),
  created_at: z.string(),
});

const adminOrderItemSchema = z.object({
  id: z.uuid(),
  menu_item_id: z.uuid().nullable(),
  variant_id: z.uuid().nullable(),
  item_name_snapshot: z.string(),
  variant_name_snapshot: z.string().nullable(),
  unit_price_cents: z.number().int(),
  modifier_unit_total_cents: z.number().int(),
  quantity: z.number().int(),
  line_total_cents: z.number().int(),
  special_instructions: z.string(),
  created_at: z.string(),
  modifiers: z.array(adminOrderModifierSchema),
});

const adminOrderDiscountSchema = z.object({
  id: z.uuid(),
  promotion_id: z.uuid().nullable(),
  code_snapshot: z.string(),
  description_snapshot: z.string(),
  discount_type_snapshot: z.string(),
  discount_value_snapshot: z.number().int(),
  amount_cents: z.number().int(),
  created_at: z.string(),
});

const adminOrderEventSchema = z.object({
  id: z.uuid(),
  event_type: z.string(),
  from_status: z.string().nullable(),
  to_status: z.string().nullable(),
  actor_user_id: z.uuid().nullable(),
  actor_name: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

export const adminOrderDetailSchema = z.object({
  id: z.uuid(),
  order_number: z.string(),
  customer_id: z.uuid().nullable(),
  source: z.enum(["online", "pos", "phone", "admin"]),
  fulfillment_type: fulfillmentSchema,
  status: z.string(),
  payment_status: z.string(),
  payment_method: z.enum(["test_manual", "cash", "card"]),
  subtotal_cents: z.number().int(),
  discount_cents: z.number().int(),
  delivery_fee_cents: z.number().int(),
  tax_cents: z.number().int(),
  tip_cents: z.number().int(),
  total_cents: z.number().int(),
  customer_name_snapshot: z.string(),
  customer_phone_snapshot: z.string(),
  customer_email_snapshot: z.string().nullable(),
  delivery_address_snapshot: z.record(z.string(), z.unknown()).nullable(),
  special_instructions: z.string(),
  pricing_snapshot: z.record(z.string(), z.unknown()),
  placed_at: z.string().nullable(),
  promised_at: z.string().nullable(),
  accepted_at: z.string().nullable(),
  ready_at: z.string().nullable(),
  out_for_delivery_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  created_by_user_id: z.uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  items: z.array(adminOrderItemSchema),
  discounts: z.array(adminOrderDiscountSchema),
  events: z.array(adminOrderEventSchema),
});

export type AdminOrderSummary = z.infer<typeof adminOrderSummarySchema>;
export type AdminCalendarDay = z.infer<typeof adminCalendarDaySchema>;
export type AdminOrderDetail = z.infer<typeof adminOrderDetailSchema>;
