import { z } from "zod";

export const openOrderStatuses = ["placed", "accepted", "in_kitchen", "ready", "out_for_delivery"] as const;
export const openOrderStatusSchema = z.enum(openOrderStatuses);
export type OpenOrderStatus = z.infer<typeof openOrderStatusSchema>;

export const orderTransitionSchema = z
  .object({
    order_id: z.uuid(),
    expected_status: openOrderStatusSchema,
    next_status: z.enum(["out_for_delivery", "completed", "cancelled"]),
    reason: z.string().trim().max(500).optional(),
  })
  .refine((value) => value.next_status !== "cancelled" || (value.reason?.length ?? 0) >= 3, {
    message: "Enter a cancellation reason of at least 3 characters.",
    path: ["reason"],
  });
export type OrderTransition = z.infer<typeof orderTransitionSchema>;

export type HandOffAction = { status: "out_for_delivery" | "completed"; label: string };

/** The normal next counter/driver step once the kitchen has finished an order. */
export function nextHandOff(status: string, fulfillment: string): HandOffAction | null {
  if (status === "ready") return fulfillment === "delivery" ? { status: "out_for_delivery", label: "Out for delivery" } : { status: "completed", label: "Picked up" };
  if (status === "out_for_delivery") return { status: "completed", label: "Delivered" };
  return null;
}

export function isOpenOrderStatus(status: string): status is OpenOrderStatus {
  return (openOrderStatuses as readonly string[]).includes(status);
}

/** Maps database errors from wayne_transition_order to messages staff can act on. */
export function transitionErrorMessage(error: { code?: string; message: string }) {
  if (error.code === "40001") return "Another screen changed this order. Refresh and try again.";
  if (error.code === "42501") return "Your account is not allowed to make this change. Ask a manager.";
  const safe = ["reason", "Only open orders", "Only ready delivery", "not found"];
  return safe.some((part) => error.message.includes(part)) ? error.message : "The order could not be updated. Refresh to check it before retrying.";
}

export const openOrderSchema = z.object({
  id: z.uuid(),
  order_number: z.string(),
  customer_name: z.string(),
  fulfillment_type: z.enum(["pickup", "delivery"]),
  source: z.string(),
  status: z.string(),
  payment_method: z.string(),
  payment_status: z.string(),
  total_cents: z.number().int(),
  placed_at: z.string(),
  promised_at: z.string().nullable(),
  ready_at: z.string().nullable(),
});
export type OpenOrder = z.infer<typeof openOrderSchema>;
