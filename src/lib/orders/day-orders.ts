import { z } from "zod";

/** One order on POS → Today's orders (owner, 2026-10-12). */
export const dayOrderSchema = z.object({
  id: z.uuid(),
  order_number: z.string(),
  daily_number: z.number().int().nullable().optional().default(null),
  /** Items added after the order was paid: the order they belong to. */
  parent_order_id: z.uuid().nullable().optional().default(null),
  parent_order_number: z.string().nullable().optional().default(null),
  customer_name: z.string().nullable().transform((value) => value ?? ""),
  customer_phone: z.string().nullable().transform((value) => value ?? ""),
  fulfillment_type: z.string(),
  source: z.string(),
  phone_line: z.number().int().nullable(),
  status: z.string(),
  payment_method: z.string(),
  payment_status: z.string(),
  subtotal_cents: z.number().int(),
  discount_cents: z.number().int(),
  delivery_fee_cents: z.number().int(),
  tax_cents: z.number().int(),
  tip_cents: z.number().int(),
  total_cents: z.number().int(),
  placed_at: z.string(),
  promised_at: z.string().nullable(),
  ready_at: z.string().nullable(),
  out_for_delivery_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  is_test: z.boolean().default(false),
  delivery_address: z.object({
    address1: z.string().optional().default(""), address2: z.string().optional().default(""),
    city: z.string().optional().default(""), state: z.string().optional().default(""),
    postal_code: z.string().optional().default(""), delivery_instructions: z.string().optional().default(""),
  }).nullable(),
  special_instructions: z.string().nullable().transform((value) => value ?? ""),
  taken_by: z.string().nullable(),
  item_count: z.number().int(),
  paid_method: z.string().nullable(),
  card_brand: z.string().nullable(),
  card_last4: z.string().nullable(),
  tendered_cents: z.number().int().nullable(),
  change_cents: z.number().int().nullable(),
  paid_at: z.string().nullable(),
});
export type DayOrder = z.infer<typeof dayOrderSchema>;

export const dayOrdersSchema = z.object({ day: z.string(), orders: z.array(dayOrderSchema) });

export const orderStatusLabels: Record<string, string> = {
  payment_pending: "Paying online", placed: "New", accepted: "Accepted", in_kitchen: "Cooking", ready: "Ready",
  out_for_delivery: "Out for delivery", completed: "Done", cancelled: "Cancelled",
};

/** "Paid · Card ····4242", "Paid · Cash", "Card on file", "Not paid". */
export function paymentSummary(order: Pick<DayOrder, "payment_status" | "payment_method" | "paid_method" | "card_brand" | "card_last4">) {
  const method = order.paid_method ?? order.payment_method;
  const card = order.card_last4 ? `${order.card_brand ? `${order.card_brand[0]!.toUpperCase()}${order.card_brand.slice(1)} ` : "Card "}····${order.card_last4}` : "Card";
  const how = method === "cash" ? "Cash" : method === "card" ? card : method === "test_manual" ? "Not paid yet" : method;
  switch (order.payment_status) {
    case "paid": return `Paid · ${how}`;
    case "authorized": return `Paid · ${card} · tip from slip pending`;
    case "refunded": return "Refunded";
    case "partially_refunded": return `Part refunded · ${how}`;
    case "failed": return "Payment failed";
    default: return method === "cash" ? "Not paid · cash due" : "Not paid";
  }
}

/** Search box: order number, name or phone digits. */
export function matchesSearch(order: DayOrder, query: string) {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  const digits = text.replace(/\D/g, "");
  return order.order_number.toLowerCase().includes(text)
    || (order.daily_number !== null && digits !== "" && String(order.daily_number) === digits.replace(/^0+/, ""))
    || order.order_number.replace(/\D/g, "").replace(/^0+/, "").startsWith(digits.replace(/^0+/, "") || "~")
    || order.customer_name.toLowerCase().includes(text)
    || (digits.length >= 3 && order.customer_phone.replace(/\D/g, "").includes(digits));
}
