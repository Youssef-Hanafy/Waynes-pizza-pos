import { z } from "zod";

export const kitchenStateSchema = z.enum(["placed", "accepted", "in_kitchen", "ready"]);
export const kitchenItemSchema = z.object({
  id: z.uuid(), name: z.string(), variant: z.string().nullable(), quantity: z.number().int(),
  instructions: z.string(), station: z.string(),
  modifiers: z.array(z.object({ name: z.string(), group: z.string(), quantity: z.number().int() })),
});
export const kitchenPayloadSchema = z.object({
  order_number: z.string(), customer_name: z.string(), source: z.string(),
  fulfillment_type: z.enum(["pickup", "delivery"]), instructions: z.string(),
  items: z.array(kitchenItemSchema),
});
export const kitchenTicketSchema = z.object({
  order_id: z.uuid(), status: z.string(), payload: kitchenPayloadSchema,
  placed_at: z.string(), promised_at: z.string().nullable(), accepted_at: z.string().nullable(),
  in_kitchen_at: z.string().nullable(), ready_at: z.string().nullable(), updated_at: z.string(),
});
export const kitchenBoardSchema = z.array(kitchenTicketSchema);
export const kitchenTransitionSchema = z.object({
  order_id: z.uuid(), expected_status: kitchenStateSchema,
  next_status: z.enum(["accepted", "in_kitchen", "ready"]),
});
export type KitchenTicket = z.infer<typeof kitchenTicketSchema>;

export const nextKitchenAction = {
  placed: { status: "accepted", label: "Accept order" },
  accepted: { status: "in_kitchen", label: "Start cooking" },
  in_kitchen: { status: "ready", label: "Mark ready" },
} as const;

export function elapsedLabel(value: string, now: number) {
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
