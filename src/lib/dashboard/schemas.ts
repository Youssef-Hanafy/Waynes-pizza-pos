import { z } from "zod";

const split = z.object({ key: z.string(), order_count: z.number().int(), total_cents: z.number().int() });
export const dashboardSchema = z.object({
  timezone: z.string(), from_date: z.string(), through_date: z.string(),
  order_count: z.number().int(), item_sales_cents: z.number().int(), gross_sales_cents: z.number().int(), discount_cents: z.number().int(),
  refund_cents: z.number().int(), net_sales_cents: z.number().int(), tax_cents: z.number().int(), tip_cents: z.number().int(),
  delivery_fee_cents: z.number().int(), average_order_cents: z.number().int(), cancelled_count: z.number().int(), cancelled_cents: z.number().int(),
  fulfillment_rows: z.array(split), source_rows: z.array(split), payment_rows: z.array(split),
  hourly: z.array(z.object({ hour: z.number().int(), order_count: z.number().int(), sales_cents: z.number().int() })),
  top_items: z.array(z.object({ item_name: z.string(), quantity: z.number().int(), sales_cents: z.number().int() })),
  recent_orders: z.array(z.object({ id: z.uuid(), order_number: z.string(), customer_name: z.string(), status: z.string(), fulfillment_type: z.string(), source: z.string(), payment_method: z.string(), total_cents: z.number().int(), placed_at: z.string() })),
  customer_mix: z.object({ new_customers: z.number().int(), returning_customers: z.number().int(), new_customer_orders: z.number().int(), returning_customer_orders: z.number().int(), guest_orders: z.number().int() }),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

export const setupStatusSchema = z.object({
  category_count: z.number().int(), menu_item_count: z.number().int(), visible_menu_item_count: z.number().int(),
  tax_rate_basis_points: z.number().int(), pickup_enabled: z.boolean(), delivery_enabled: z.boolean(), delivery_postal_code_count: z.number().int(),
  delivery_fee_cents: z.number().int(), delivery_minimum_cents: z.number().int(), ordering_open: z.boolean(), test_ordering_enabled: z.boolean(),
  public_phone_set: z.boolean(), hanafy_configured: z.boolean(), hanafy_active: z.boolean(), hanafy_failed_count: z.number().int(), hanafy_queued_count: z.number().int(),
  active_staff_count: z.number().int(), pending_staff_count: z.number().int(), open_order_count: z.number().int(), stale_open_order_count: z.number().int(),
  failed_print_job_count: z.number().int(), active_promotion_count: z.number().int(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

export type ChecklistItem = { done: boolean; label: string; detail: string; href: string };

/** Go-live checklist (audit H3): data only the owner can supply. */
export function goLiveChecklist(setup: SetupStatus): ChecklistItem[] {
  return [
    { done: setup.visible_menu_item_count > 0, label: "Add the menu", detail: setup.menu_item_count ? `${setup.visible_menu_item_count} of ${setup.menu_item_count} items visible to customers` : "No menu items yet — customers cannot order", href: "/admin/menu" },
    { done: setup.tax_rate_basis_points > 0, label: "Set the sales/meals tax rate", detail: setup.tax_rate_basis_points ? `${(setup.tax_rate_basis_points / 100).toFixed(2)}%` : "Tax is 0% — confirm the Worcester meals-tax rate with your accountant", href: "/admin/settings" },
    { done: !setup.delivery_enabled || setup.delivery_postal_code_count > 0, label: "Limit delivery to your area", detail: !setup.delivery_enabled ? "Delivery is off" : setup.delivery_postal_code_count ? `${setup.delivery_postal_code_count} ZIP codes` : "No delivery ZIP codes — any address can order delivery", href: "/admin/settings" },
    { done: !setup.delivery_enabled || setup.delivery_fee_cents > 0 || setup.delivery_minimum_cents > 0, label: "Confirm delivery fee and minimum", detail: !setup.delivery_enabled ? "Delivery is off" : `Fee $${(setup.delivery_fee_cents / 100).toFixed(2)} · minimum $${(setup.delivery_minimum_cents / 100).toFixed(2)}`, href: "/admin/settings" },
    { done: setup.public_phone_set, label: "Publish the store phone number", detail: setup.public_phone_set ? "Set" : "Customers are told to call when ordering is unavailable", href: "/admin/settings" },
    { done: setup.active_staff_count > 1, label: "Give each staff member a sign-in", detail: `${setup.active_staff_count} active account${setup.active_staff_count === 1 ? "" : "s"}${setup.pending_staff_count ? ` · ${setup.pending_staff_count} waiting for access` : ""}`, href: "/admin/staff" },
    { done: setup.hanafy_active, label: "Connect Hanafy CRM", detail: setup.hanafy_active ? "Delivering events" : setup.hanafy_configured ? `Paused — ${setup.hanafy_queued_count} events waiting` : "Not configured — events are queued", href: "/admin/integrations" },
  ];
}
