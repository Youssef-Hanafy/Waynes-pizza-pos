import { z } from "zod";

export const deliveryAddressSchema = z.object({
  address1: z.string().default(""),
  address2: z.string().default(""),
  city: z.string().default(""),
  state: z.string().default(""),
  postal_code: z.string().default(""),
  delivery_instructions: z.string().default(""),
});
export type DeliveryAddress = z.infer<typeof deliveryAddressSchema>;

export const assignmentStatuses = ["assigned", "accepted", "picked_up", "delivered", "released"] as const;
export const assignmentStatusSchema = z.enum(assignmentStatuses);
export type AssignmentStatus = z.infer<typeof assignmentStatusSchema>;

const orderPartSchema = z.object({
  order_id: z.uuid(),
  order_number: z.string(),
  customer_name: z.string(),
  customer_phone: z.string(),
  address: deliveryAddressSchema.partial().default({}),
  delivery_instructions: z.string().default(""),
  order_instructions: z.string().default(""),
  status: z.string(),
  payment_method: z.string(),
  payment_status: z.string(),
  total_cents: z.number().int(),
  amount_due_cents: z.number().int(),
  placed_at: z.string().nullable(),
  promised_at: z.string().nullable(),
  ready_at: z.string().nullable(),
  out_for_delivery_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  items: z.array(z.object({ name: z.string(), variant: z.string().nullable(), quantity: z.number().int() })).default([]),
});

const assignmentPartSchema = z.object({
  assignment_id: z.uuid(),
  driver_id: z.uuid(),
  driver_name: z.string().nullable(),
  assignment_status: assignmentStatusSchema,
  self_claimed: z.boolean(),
  assigned_at: z.string(),
  accepted_at: z.string().nullable(),
  picked_up_at: z.string().nullable(),
  delivered_at: z.string().nullable(),
  cash_collected_cents: z.number().int(),
  amount_due_cents: z.number().int(),
  delivery_note: z.string().default(""),
});

/** One row on the driver screen: the order plus the driver's own assignment. */
export const driverAssignmentSchema = orderPartSchema.extend(assignmentPartSchema.shape);
export type DriverAssignment = z.infer<typeof driverAssignmentSchema>;

/** An unclaimed ready delivery. Address and phone stay hidden until a driver claims it. */
export const availableDeliverySchema = z.object({
  order_id: z.uuid(),
  order_number: z.string(),
  customer_name: z.string(),
  city: z.string().default(""),
  postal_code: z.string().default(""),
  total_cents: z.number().int(),
  amount_due_cents: z.number().int(),
  ready_at: z.string().nullable(),
  promised_at: z.string().nullable(),
});
export type AvailableDelivery = z.infer<typeof availableDeliverySchema>;

export const driverBoardSchema = z.object({
  assignments: z.array(driverAssignmentSchema).default([]),
  available: z.array(availableDeliverySchema).default([]),
});
export type DriverBoard = z.infer<typeof driverBoardSchema>;

export const dispatchOrderSchema = orderPartSchema.extend({ assignment: assignmentPartSchema.nullable() });
export type DispatchOrder = z.infer<typeof dispatchOrderSchema>;

export const dispatchBoardSchema = z.object({
  drivers: z.array(z.object({ driver_id: z.uuid(), display_name: z.string(), active_count: z.number().int() })).default([]),
  orders: z.array(dispatchOrderSchema).default([]),
});
export type DispatchBoard = z.infer<typeof dispatchBoardSchema>;

export const deliveryMetricsSchema = z.object({
  totals: z.object({
    assigned_count: z.number().int(), delivered_count: z.number().int(), in_progress_count: z.number().int(),
    released_count: z.number().int(), delivered_sales_cents: z.number().int(), cash_collected_cents: z.number().int(),
    cash_short_cents: z.number().int(), average_door_minutes: z.number().int(), average_assignment_minutes: z.number().int(),
    late_count: z.number().int(),
  }),
  drivers: z.array(z.object({
    driver_id: z.uuid().nullable(), driver_name: z.string(), assigned_count: z.number().int(), delivered_count: z.number().int(),
    released_count: z.number().int(), delivered_sales_cents: z.number().int(), cash_collected_cents: z.number().int(),
    cash_short_cents: z.number().int(), average_door_minutes: z.number().int(), late_count: z.number().int(),
  })).default([]),
  exceptions: z.array(z.object({
    order_number: z.string(), driver_name: z.string(), issue: z.string(), detail: z.string(), occurred_at: z.string().nullable(),
  })).default([]),
});
export type DeliveryMetrics = z.infer<typeof deliveryMetricsSchema>;

/** Driver actions. Cash is only ever recorded on delivery; card-at-door arrives in Phase 11. */
export const driverActionSchema = z
  .object({
    order_id: z.uuid(),
    action: z.enum(["claim", "accept", "picked_up", "delivered"]),
    cash_collected_cents: z.number().int().min(0).max(1_000_000).nullable().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((value) => value.action !== "delivered" || value.cash_collected_cents !== undefined, {
    message: "Record the cash collected before completing a delivery.",
    path: ["cash_collected_cents"],
  });
export type DriverAction = z.infer<typeof driverActionSchema>;

export const assignDeliverySchema = z.object({ order_id: z.uuid(), driver_id: z.uuid() });
export const releaseDeliverySchema = z.object({ order_id: z.uuid(), reason: z.string().trim().min(3).max(500) });

/** Turns a stored address snapshot into a single line for display and for map links. */
export function formatAddress(address: Partial<DeliveryAddress> | null | undefined) {
  if (!address) return "";
  const street = [address.address1, address.address2].map((part) => (part ?? "").trim()).filter(Boolean).join(" ");
  const region = [address.city, address.state].map((part) => (part ?? "").trim()).filter(Boolean).join(", ");
  return [street, region, (address.postal_code ?? "").trim()].filter(Boolean).join(", ");
}

/**
 * Navigation hand-off. A plain maps query URL opens the phone's default map app on
 * iOS and Android without shipping a maps SDK or leaking an API key.
 */
export function navigationUrl(address: Partial<DeliveryAddress> | null | undefined) {
  const line = formatAddress(address);
  return line ? `https://maps.google.com/?q=${encodeURIComponent(line)}` : "";
}

export function telephoneUrl(phone: string) {
  const digits = (phone ?? "").replace(/[^\d+]/g, "");
  return digits ? `tel:${digits}` : "";
}

export const driverStepLabels: Record<AssignmentStatus, string> = {
  assigned: "Assigned to you",
  accepted: "Accepted",
  picked_up: "Out for delivery",
  delivered: "Delivered",
  released: "Released",
};

/** The one action a driver should take next on an assignment, or null when finished. */
export function nextDriverAction(status: AssignmentStatus, orderStatus: string) {
  if (status === "assigned") return { action: "accept" as const, label: "Accept delivery", ready: true };
  if (status === "accepted") return { action: "picked_up" as const, label: "Picked up", ready: orderStatus === "ready" || orderStatus === "out_for_delivery" };
  if (status === "picked_up") return { action: "delivered" as const, label: "Delivered", ready: true };
  return null;
}

/** Parses what a driver typed into the cash box. Accepts "24", "24.50", "$24.50". */
export function parseCashInput(raw: string) {
  const cleaned = (raw ?? "").replace(/[$,\s]/g, "");
  if (!cleaned) return { ok: false as const, error: "Enter the cash you collected, or 0 if none." };
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { ok: false as const, error: "Enter an amount such as 24.50." };
  const cents = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(cents) || cents > 1_000_000) return { ok: false as const, error: "That amount is too large." };
  return { ok: true as const, cents };
}

export function minutesBetween(from: string | null, to: string | null) {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 60_000));
}

/** Maps database errors from the delivery RPCs to something staff can act on. */
export function deliveryErrorMessage(error: { code?: string; message: string }) {
  if (error.code === "40001") return "Another screen changed this delivery. Refresh and try again.";
  if (error.code === "42501") return "Your account is not allowed to make this change. Ask a manager.";
  const safe = [
    "driver access", "not assigned to you", "ready", "cash", "reason", "already", "Only",
    "Order not found", "Driver not found", "no longer out for delivery", "cancelled",
  ];
  return safe.some((part) => error.message.toLowerCase().includes(part.toLowerCase()))
    ? error.message
    : "The delivery could not be updated. Refresh to check it before retrying.";
}
