import { z } from "zod";

/**
 * Hanafy billing + equipment (Phase 11, build sheet §23, §38).  Money the
 * business owes HANAFY — never the restaurant's own customer payments.
 * All amounts are integer cents.
 */
const cents = z.coerce.number().int();
const date = z.string().nullable();
const timestamp = z.string();

export const billingTotalsSchema = z.object({
  agreement: z.object({ label: z.string(), status: z.string(), plan_name: z.string().nullable() }).nullable(),
  monthly_recurring_cents: cents,
  open_invoices: cents,
  open_balance_cents: cents,
  overdue_invoices: cents,
  overdue_balance_cents: cents,
  equipment_balance_cents: cents,
  equipment_assets: cents,
});
export type BillingTotals = z.infer<typeof billingTotalsSchema>;

export const paymentMethods = ["check", "ach", "zelle", "cash", "card", "other"] as const;
export const paymentMethodLabels: Record<(typeof paymentMethods)[number], string> = {
  check: "Check", ach: "Bank transfer (ACH)", zelle: "Zelle", cash: "Cash", card: "Card", other: "Other",
};
export const billingIntervals = ["monthly", "quarterly", "yearly"] as const;

const paymentSchema = z.object({
  id: z.uuid(), amount_cents: cents, paid_on: z.string(), method: z.enum(paymentMethods), reference: z.string().nullable(),
  notes: z.string().nullable().optional(), voided_at: timestamp.nullable(), void_reason: z.string().nullable(),
});

export const invoiceSchema = z.object({
  id: z.uuid(),
  invoice_number: z.string(),
  status: z.enum(["draft", "open", "paid", "void"]),
  issue_date: date, due_date: date, period_start: date, period_end: date,
  total_cents: cents, paid_cents: cents, balance_due_cents: cents, overdue: z.boolean(),
  notes: z.string().nullable().optional(), void_reason: z.string().nullable(),
  issued_at: timestamp.nullable(), paid_at: timestamp.nullable(), voided_at: timestamp.nullable(), created_at: timestamp,
  items: z.array(z.object({ id: z.uuid(), kind: z.string(), description: z.string(), quantity: z.number().int(), unit_price_cents: cents, amount_cents: cents })),
  payments: z.array(paymentSchema),
});
export type PlatformInvoice = z.infer<typeof invoiceSchema>;

export const equipmentAssetSchema = z.object({
  id: z.uuid(), name: z.string(), vendor: z.string().nullable(), model: z.string().nullable(), serial_number: z.string().nullable(),
  ownership_type: z.enum(["customer_owned", "hanafy_owned", "financed", "leased"]),
  hanafy_cost_cents: cents.nullable(), customer_price_cents: cents.nullable(), payment_schedule: z.string().nullable(),
  purchased_at: date, assigned_at: date, status: z.enum(["active", "returned", "written_off"]), notes: z.string().nullable(),
  hardware_device_id: z.uuid().nullable(), device_name: z.string().nullable(), location_name: z.string().nullable(),
  charges: z.array(z.object({ id: z.uuid(), amount_cents: cents, charged_on: z.string(), description: z.string() })),
  payments: z.array(paymentSchema),
  charged_cents: cents, paid_cents: cents, balance_due_cents: cents,
});
export type EquipmentAsset = z.infer<typeof equipmentAssetSchema>;

export const platformWorkspaceBillingSchema = z.object({
  can_manage: z.boolean(),
  totals: billingTotalsSchema,
  subscriptions: z.array(z.object({
    id: z.uuid(), kind: z.enum(["base", "addon"]), label: z.string(), status: z.enum(["trial", "active", "paused", "cancelled"]),
    plan_id: z.uuid().nullable(), plan_name: z.string().nullable(), price_cents: cents, billing_interval: z.enum(billingIntervals),
    monthly_equivalent_cents: cents, start_date: z.string(), end_date: date, custom_terms: z.string().nullable(),
  })),
  invoices: z.array(invoiceSchema),
  equipment: z.array(equipmentAssetSchema),
  devices: z.array(z.object({ id: z.uuid(), name: z.string(), device_type: z.string(), ownership_type: z.string(), has_asset: z.boolean() })),
  plans: z.array(z.object({ id: z.uuid(), code: z.string(), name: z.string(), active: z.boolean(), base_monthly_price_cents: cents.nullable() })),
});
export type PlatformWorkspaceBilling = z.infer<typeof platformWorkspaceBillingSchema>;

export const platformBillingOverviewSchema = z.object({
  can_manage: z.boolean(),
  workspaces: z.array(billingTotalsSchema.extend({ slug: z.string(), name: z.string(), status: z.string() })),
  plans: z.array(z.object({
    id: z.uuid(), code: z.string(), name: z.string(), description: z.string(), active: z.boolean(), base_monthly_price_cents: cents.nullable(),
    services: z.array(z.string()), subscribers: cents,
  })),
  services: z.array(z.object({ code: z.string(), name: z.string() })),
  overdue: z.array(invoiceSchema.extend({ workspace_slug: z.string(), workspace_name: z.string() })),
});
export type PlatformBillingOverview = z.infer<typeof platformBillingOverviewSchema>;

export const dashboardBillingSchema = z.object({
  monthly_recurring_cents: cents,
  open_balance_cents: cents,
  overdue_balance_cents: cents,
  overdue_invoices: cents,
  equipment_balance_cents: cents,
  without_agreement: cents,
});

export const workspaceHanafyBillingSchema = z.object({
  totals: billingTotalsSchema,
  invoices: z.array(invoiceSchema),
  equipment: z.array(z.object({ name: z.string(), ownership_type: z.string(), payment_schedule: z.string().nullable(), charged_cents: cents, paid_cents: cents, balance_due_cents: cents })),
});
export type WorkspaceHanafyBilling = z.infer<typeof workspaceHanafyBillingSchema>;

export const billingResultSchema = z.looseObject({ status: z.enum(["saved", "voided"]), id: z.uuid().nullable().optional(), invoice_number: z.string().optional() });
