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
    clocked_in: z.boolean().default(false),
    last_cashout_at: z.string().nullable().optional().transform((value) => value ?? null),
    orders: z.array(posDeliveryOrderSchema).default([]),
  })).default([]),
});
export type PosDeliveryBoard = z.infer<typeof posDeliveryBoardSchema>;

export const posDeliveryActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send_out"), order_id: z.uuid(), driver_id: z.uuid() }),
  z.object({ action: z.literal("unassign"), order_id: z.uuid() }),
  /** The driver types his PIN; the chosen orders go out with him (owner, 2026-10-12). */
  z.object({ action: z.literal("send_out_pin"), order_ids: z.array(z.uuid()).min(1).max(30), pin: z.string().regex(/^\d{4,6}$/, "Wrong PIN.") }),
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
  detail: z.array(z.object({
    order_id: z.uuid(), order_number: z.string(), paid_by: z.string(),
    total_cents: z.number().int(), tip_cents: z.number().int(), cash_cents: z.number().int(),
  })).default([]),
});
export type PosCashoutResult = z.infer<typeof posCashoutResultSchema>;

/**
 * Whether a tip typed at cash-out can be taken for this order.
 *   card_held  – a delivery card authorised for the order: the tip on the slip
 *                is added when it is captured (tip adjust, owner 2026-10-11)
 *   cash       – tip kept by the driver
 *   card/paid  – charged already (pickup card, online): the tip came with it
 */
export function tipAllowed(order: Pick<PosDeliveryOrder, "paid_by">) {
  return order.paid_by === "card_held" || order.paid_by === "cash" || order.paid_by === "cash_paid";
}

/**
 * The biggest tip that can go on this order.  For a delivery card it is what
 * Stripe says the card can be captured for, less the order (hold_cents carries
 * that maximum); 0 means Stripe won't let this card be increased.
 */
export function maxTipCents(order: Pick<PosDeliveryOrder, "paid_by" | "hold_cents" | "total_cents">) {
  if (order.paid_by !== "card_held") return 50_000;
  return Math.max(0, (order.hold_cents ?? order.total_cents) - order.total_cents);
}

/** One order on the driver's run, the way the cash-out reads it back. */
export type CashoutLine = {
  order: PosDeliveryOrder;
  /** The tip that counts for this order. */
  tip: number;
  /** Cash the driver collected at the door for the order (tip not included). */
  collected: number;
  /** Tip the store owes the driver out of the drawer (card / online tips). */
  storePays: number;
  /** Cash tip the driver already has in their pocket. */
  keeps: number;
};

/**
 * What a cash-out comes to, order by order and in total, before it is sent:
 *   cash orders    – the order totals the driver collected at the door (tips excluded)
 *   card tips      – card / online tips: the store pays these out of the drawer
 *   cash tips      – the driver keeps them, so they cancel out
 *   hand in        – cash orders minus the card tips (negative = pay the driver)
 */
export function cashoutLines(orders: PosDeliveryOrder[], tips: Record<string, number>): CashoutLine[] {
  return orders.map((order) => {
    if (order.paid_by === "card" || order.paid_by === "paid") {
      const tip = Math.max(0, order.tip_cents);
      return { order, tip, collected: 0, storePays: tip, keeps: 0 };
    }
    const tip = tipAllowed(order) ? Math.min(Math.max(0, tips[order.order_id] ?? 0), maxTipCents(order)) : 0;
    if (order.paid_by === "cash") return { order, tip, collected: order.total_cents, storePays: 0, keeps: tip };
    if (order.paid_by === "cash_paid") return { order, tip, collected: 0, storePays: 0, keeps: tip };
    return { order, tip, collected: 0, storePays: tip, keeps: 0 }; // card_held: tip added to the card
  });
}

export function cashoutSummary(orders: PosDeliveryOrder[], tips: Record<string, number>) {
  let cashOrders = 0;
  let cashTips = 0;
  let cardTips = 0;
  for (const line of cashoutLines(orders, tips)) {
    cashOrders += line.collected;
    cashTips += line.keeps;
    cardTips += line.storePays;
  }
  return { cashOrders, cashTips, cardTips, tips: cashTips + cardTips, handIn: cashOrders - cardTips };
}

export function paidByLabel(order: Pick<PosDeliveryOrder, "paid_by" | "card_label">) {
  switch (order.paid_by) {
    case "card_held": return `${order.card_label || "Card"} · add tip`;
    case "card": return `${order.card_label || "Card"} · charged at counter`;
    case "paid": return "Paid online";
    case "cash_paid": return "Cash (collected)";
    default: return "Cash";
  }
}
