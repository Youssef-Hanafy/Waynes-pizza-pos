/**
 * The number staff and customers say (owner, 2026-10-13: "everyday start at
 * 1, 2, 3"): the day's ticket number when the order has one, otherwise the
 * permanent order number without its W000 prefix (orders placed before daily
 * numbers existed).  An add-on keeps the number of the order it belongs to.
 */
export function ticketNumber(order: { order_number: string; daily_number?: number | null }) {
  if (typeof order.daily_number === "number" && order.daily_number > 0) return String(order.daily_number);
  return order.order_number.replace(/^W0*/, "") || order.order_number;
}

/** "#12", or "#12 add-on" for items added to an order that was already paid. */
export function ticketLabel(order: { order_number: string; daily_number?: number | null; parent_order_id?: string | null }) {
  return `#${ticketNumber(order)}${order.parent_order_id ? " add-on" : ""}`;
}
