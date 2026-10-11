import { z } from "zod";

/**
 * The POS Deliveries tab (owner, 2026-10-11): orders waiting to go out, and
 * each driver's run until they are cashed out.  Mirrors
 * wayne_pos_delivery_board / wayne_pos_delivery_order_json.
 */
export const paidBySchema = z.enum(["card_held", "card", "paid", "cash_paid", "cash"]);
export type PaidBy = z.infer<typeof paidBySchema>;

export const posDeliveryOrderSchema = z.object({
  order_id: z.uuid(),
  order_number: z.string(),
  customer_name: z.string().default(""),
  customer_phone: z.string().default(""),
  address: z.string().default(""),
  city: z.string().default(""),
  status: z.string(),
  source: z.string().default(""),
  is_test: z.boolean().default(false),
  payment_status: z.string(),
  payment_method: z.string(),
  total_cents: z.number().int(),
  tip_cents: z.number().int().default(0),
  placed_at: z.string().nullable(),
  promised_at: z.string().nullable().optional().transform((value) => value ?? null),
  paid_by: paidBySchema,
  hold_cents: z.number().int().nullable().optional().transform((value) => value ?? null),
  held_at: z.string().nullable().optional().transform((value) => value ?? null),
  card_label: z.string().nullable().optional().transform((value) => value ?? null),
  assignment_status: z.string().optional(),
  assigned_at: z.string().nullable().optional(),
  delivered_at: z.string().nullable().optional(),
});
export type PosDeliveryOrder = z.infer<typeof posDeliveryOrderSchema>;

export const posDeliveryBoardSchema = z.object({
  waiting: z.array(posDeliveryOrderSchema).default([]),
  drivers: z.array(z.object({
    driver_id: z.uuid(),
    name: z.string(),
    last_cashout_at: z.string().nullable().optional().transform((value) => value ?? null),
    orders: z.array(posDeliveryOrderSchema).default([]),
  })).default([]),
});
export type PosDeliveryBoard = z.infer<typeof posDeliveryBoardSchema>;

export const posDeliveryActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send_out"), order_id: z.uuid(), driver_id: z.uuid() }),
  z.object({ action: z.literal("unassign"), order_id: z.uuid() }),
]);

export const posCashoutRequestSchema = z.object({
  driver_id: z.uuid(),
  tips: z.array(z.object({ order_id: z.uuid(), tip_cents: z.number().int().min(0).max(50_000) })).max(100),
  note: z.string().trim().max(500).default(""),
});

export const posCashoutResultSchema = z.object({
  cashout_id: z.uuid(),
  driver_name: z.string(),
  order_count: z.number().int(),
  cash_orders_cents: z.number().int(),
  cash_tips_cents: z.number().int(),
  card_tips_cents: z.number().int(),
  hand_in_cents: z.number().int(),
});
export type PosCashoutResult = z.infer<typeof posCashoutResultSchema>;

/** Whether a tip typed at cash-out can be taken for this order. */
export function tipAllowed(order: Pick<PosDeliveryOrder, "paid_by">) {
  // Card / online orders: the tip was charged with the order (asked on the phone).
  return order.paid_by === "card_held" || order.paid_by === "cash" || order.paid_by === "cash_paid";
}

/** The most a held card can be charged: the hold (order + 30%). */
export function maxTipCents(order: Pick<PosDeliveryOrder, "paid_by" | "hold_cents" | "total_cents">) {
  if (order.paid_by !== "card_held") return 50_000;
  return Math.max(0, (order.hold_cents ?? order.total_cents) - order.total_cents);
}

/**
 * What a cash-out comes to, before it is sent:
 *   cash orders    – the order totals the driver collected at the door (tips excluded)
 *   tips           – every tip, which the driver keeps
 *   hand in        – cash orders minus the card tips the store owes the driver
 *                    (card tips were charged with the order, on the phone or online)
 * (cash tips are already in the driver's pocket, so they cancel out).
 */
export function cashoutSummary(orders: PosDeliveryOrder[], tips: Record<string, number>) {
  let cashOrders = 0;
  let cashTips = 0;
  let cardTips = 0;
  for (const order of orders) {
    if (order.paid_by === "card" || order.paid_by === "paid") { cardTips += Math.max(0, order.tip_cents); continue; }
    const tip = tipAllowed(order) ? Math.min(Math.max(0, tips[order.order_id] ?? 0), maxTipCents(order)) : 0;
    if (order.paid_by === "cash") { cashOrders += order.total_cents; cashTips += tip; }
    else if (order.paid_by === "cash_paid") cashTips += tip;
    else if (order.paid_by === "card_held") cardTips += tip;
  }
  return { cashOrders, cashTips, cardTips, tips: cashTips + cardTips, handIn: cashOrders - cardTips };
}

export function paidByLabel(order: Pick<PosDeliveryOrder, "paid_by" | "card_label">) {
  switch (order.paid_by) {
    case "card_held": return `${order.card_label || "Card"} · held`;
    case "card": return `${order.card_label || "Card"} · charged`;
    case "paid": return "Paid online";
    case "cash_paid": return "Cash (collected)";
    default: return "Cash";
  }
}
