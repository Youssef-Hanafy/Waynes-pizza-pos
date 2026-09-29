import { z } from "zod";
import { billingTotalsSchema, dashboardBillingSchema } from "./billing";

/**
 * Hanafy Platform Admin (Phase 6) response shapes.  Every value comes from a
 * SECURITY DEFINER function that checks the caller's platform role itself;
 * these schemas only make the shapes safe to render.
 */

export const platformRoleSchema = z.enum(["platform_owner", "platform_admin", "platform_support", "platform_billing", "platform_read_only"]);
export type PlatformRole = z.infer<typeof platformRoleSchema>;

export const platformRoleLabels: Record<PlatformRole, string> = {
  platform_owner: "Platform owner",
  platform_admin: "Platform admin",
  platform_support: "Support",
  platform_billing: "Billing",
  platform_read_only: "Read only",
};

const workspaceStatusSchema = z.enum(["provisioning", "active", "suspended", "archived"]);
const timestamp = z.string();
const count = z.coerce.number().int().nonnegative();

export const mySupportSessionSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  workspace_slug: z.string(),
  workspace_name: z.string(),
  expires_at: timestamp,
  reason: z.string(),
  platform_role: z.string().optional(),
});
export type MySupportSession = z.infer<typeof mySupportSessionSchema>;

export const platformMeSchema = z.object({
  auth_user_id: z.uuid(),
  email: z.string().nullable(),
  display_name: z.string(),
  platform_role: platformRoleSchema,
  can_manage: z.boolean(),
  can_support: z.boolean(),
  support_session: mySupportSessionSchema.nullable(),
});
export type PlatformMe = z.infer<typeof platformMeSchema>;

export const healthIssueSchema = z.object({
  severity: z.enum(["warn", "alert"]),
  code: z.string(),
  message: z.string(),
});
export type HealthIssue = z.infer<typeof healthIssueSchema>;

export const workspaceHealthSchema = z.object({
  level: z.enum(["ok", "warn", "alert"]),
  issues: z.array(healthIssueSchema),
  outbox: z.object({
    pending: count,
    failed: count,
    oldest_pending_at: timestamp.nullable(),
    last_delivered_at: timestamp.nullable(),
    last_error: z.string().nullable(),
    crm_enabled: z.boolean(),
  }),
  printing: z.object({ failed_24h: count, stuck: count }),
  payments: z.object({ webhook_problems_7d: count }),
  orders: z.object({ last_order_at: timestamp.nullable(), last_24h: count }),
  caller_id: z.object({ last_ring_at: timestamp.nullable() }),
  hardware: z.object({ devices: count, monitored: count, problems: count, never_seen: count }).optional(),
});
export type WorkspaceHealth = z.infer<typeof workspaceHealthSchema>;

export const workspaceSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  status: workspaceStatusSchema,
  created_at: timestamp,
  primary_location: z.object({
    id: z.uuid(),
    name: z.string(),
    city: z.string().nullable(),
    state_region: z.string().nullable(),
    status: z.string(),
  }).nullable(),
  location_count: count,
  services: z.array(z.string()),
  owner: z.object({ name: z.string().nullable(), email: z.string().nullable() }).nullable(),
  member_count: count,
  messaging: z.object({ channel: z.string(), sender_address: z.string(), provider: z.string(), active: z.boolean() }).nullable(),
  payment: z.object({
    provider: z.string(),
    environment: z.string().nullable(),
    online_card_enabled: z.boolean(),
    terminal_card_enabled: z.boolean(),
  }).nullable(),
  hardware: z.object({
    registers: count,
    caller_lines: count,
    devices: count.default(0),
    monitored: count.default(0),
    problems: count.default(0),
    never_seen: count.default(0),
  }),
  health: workspaceHealthSchema,
  billing: billingTotalsSchema.nullable(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const platformAuditEntrySchema = z.object({
  id: z.coerce.number(),
  occurred_at: timestamp,
  actor_name: z.string(),
  actor_role: z.string().nullable().optional(),
  action: z.string(),
  summary: z.string(),
  reason: z.string().nullable().optional(),
  workspace_slug: z.string().nullable().optional(),
  workspace_name: z.string().nullable().optional(),
  before_data: z.unknown().optional(),
  after_data: z.unknown().optional(),
  support_session_id: z.uuid().nullable().optional(),
});
export type PlatformAuditEntry = z.infer<typeof platformAuditEntrySchema>;

export const liveSupportSessionSchema = z.object({
  id: z.uuid(),
  workspace_slug: z.string(),
  workspace_name: z.string(),
  actor_name: z.string(),
  platform_role: z.string(),
  reason: z.string(),
  started_at: timestamp,
  expires_at: timestamp,
});

export const platformDashboardSchema = z.object({
  workspaces: z.object({ total: count, active: count, provisioning: count, suspended: count, archived: count }),
  totals: z.object({ customers: count, orders_24h: count, members: count, platform_users: count }),
  workspace_rows: z.array(workspaceSummarySchema),
  issues: z.array(healthIssueSchema.extend({ workspace_slug: z.string(), workspace_name: z.string() })),
  support_sessions: z.array(liveSupportSessionSchema),
  recent_audit: z.array(platformAuditEntrySchema),
  billing: dashboardBillingSchema.nullable(),
});
export type PlatformDashboard = z.infer<typeof platformDashboardSchema>;

export const serviceEntrySchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  catalog_active: z.boolean(),
  status: z.enum(["enabled", "trial", "disabled", "suspended"]),
  source: z.enum(["plan", "manual", "custom_contract"]).nullable(),
  starts_at: timestamp.nullable(),
  ends_at: timestamp.nullable(),
  enabled_at: timestamp.nullable(),
  disabled_at: timestamp.nullable(),
  updated_at: timestamp.nullable(),
  effective: z.boolean(),
  requires_any: z.array(z.string()),
  requirement_note: z.string().nullable(),
  required_by: z.array(z.string()),
  permissions: z.array(z.string()),
});
export type ServiceEntry = z.infer<typeof serviceEntrySchema>;

export const supportSessionRecordSchema = z.object({
  id: z.uuid(),
  actor_name: z.string(),
  platform_role: z.string(),
  reason: z.string(),
  ticket_reference: z.string().nullable(),
  started_at: timestamp,
  expires_at: timestamp,
  ended_at: timestamp.nullable(),
  end_reason: z.string().nullable(),
  live: z.boolean(),
  actions: count,
});
export type SupportSessionRecord = z.infer<typeof supportSessionRecordSchema>;

export const workspaceDetailSchema = workspaceSummarySchema.extend({
  timezone: z.string(),
  currency_code: z.string(),
  locations: z.array(z.object({
    id: z.uuid(),
    slug: z.string(),
    name: z.string(),
    status: z.string(),
    city: z.string().nullable(),
    state_region: z.string().nullable(),
    phone_number: z.string().nullable(),
    timezone: z.string().nullable(),
  })),
  domains: z.array(z.object({ hostname: z.string(), is_canonical: z.boolean(), active: z.boolean() })),
  service_catalog: z.array(serviceEntrySchema),
  counts: z.object({ customers: count, orders_total: count, orders_30d: count }),
  messaging_identities: z.array(z.object({
    channel: z.string(),
    sender_name: z.string().nullable(),
    sender_address: z.string(),
    provider: z.string(),
    active: z.boolean(),
    updated_at: timestamp,
  })),
  payment_configurations: z.array(z.object({
    location_id: z.uuid(),
    provider: z.string(),
    environment: z.string().nullable(),
    provider_location_id: z.string().nullable(),
    online_card_enabled: z.boolean(),
    terminal_card_enabled: z.boolean(),
    updated_at: timestamp,
  })),
  last_card_payment_at: timestamp.nullable(),
  support_sessions: z.array(supportSessionRecordSchema),
});
export type WorkspaceDetail = z.infer<typeof workspaceDetailSchema>;

export const workspaceMembersSchema = z.object({
  members: z.array(z.object({
    auth_user_id: z.uuid(),
    email: z.string().nullable(),
    display_name: z.string().nullable(),
    role: z.string(),
    role_name: z.string(),
    status: z.enum(["active", "invited", "suspended"]),
    last_sign_in_at: timestamp.nullable(),
    joined_at: timestamp,
    is_platform_user: z.boolean(),
  })),
  roles: z.array(z.object({ code: z.string(), name: z.string(), description: z.string().nullable(), permissions: z.array(z.string()) })),
});
export type WorkspaceMembers = z.infer<typeof workspaceMembersSchema>;

export const workspaceAuditSchema = z.object({
  workspace: z.array(z.object({
    id: z.coerce.number(),
    occurred_at: timestamp,
    actor_name: z.string(),
    actor_type: z.enum(["workspace_user", "platform_user", "system"]),
    action: z.string(),
    entity_type: z.string(),
    summary: z.string(),
    reason: z.string().nullable(),
    support_session_id: z.uuid().nullable(),
  })),
  platform: z.array(platformAuditEntrySchema),
});
export type WorkspaceAudit = z.infer<typeof workspaceAuditSchema>;

export const setServiceResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), effective: z.boolean() }),
  z.object({ status: z.literal("unchanged") }),
  z.object({ status: z.literal("needs_confirmation"), warnings: z.array(z.string()) }),
]);

// ---------------------------------------------------------------------------
// Form input
// ---------------------------------------------------------------------------
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);
const reason = z.string().trim().min(3, "Give a reason for the change.").max(500, "Keep the reason under 500 characters.");
const optionalDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).transform((value) => value || null);

export const setServiceInputSchema = z.object({
  workspace: slug,
  service: z.string().regex(/^[a-z][a-z0-9_]*$/).max(60),
  status: z.enum(["enabled", "trial", "disabled", "suspended"]),
  source: z.enum(["plan", "manual", "custom_contract"]),
  starts_on: optionalDate,
  ends_on: optionalDate,
  reason,
  confirmed: z.boolean(),
});
export type SetServiceInput = z.infer<typeof setServiceInputSchema>;

const password = z.string().min(12, "Passwords must be at least 12 characters.").max(72, "Passwords must be 72 characters or fewer.")
  .regex(/[a-z]/, "Include a lowercase letter.").regex(/[A-Z]/, "Include an uppercase letter.").regex(/[0-9]/, "Include a number.");

export const setMemberInputSchema = z.object({
  workspace: slug,
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.")),
  role: z.string().regex(/^[a-z][a-z_]*$/).max(60),
  status: z.enum(["active", "suspended"]),
  reason,
  // Only used to create a sign-in when no account has this email yet.
  display_name: z.string().trim().max(120).optional().transform((value) => value || undefined),
  password: password.optional().or(z.literal("").transform(() => undefined)),
});
export type SetMemberInput = z.infer<typeof setMemberInputSchema>;

export const startSupportInputSchema = z.object({
  workspace: slug,
  reason: z.string().trim().min(5, "Say why you need to enter this business (at least 5 characters).").max(500),
  ticket: z.string().trim().max(120).optional().transform((value) => value || null),
  minutes: z.coerce.number().int().min(15).max(480),
});

/** Error text from our own RPCs is written for people; anything else is not shown. */
export function platformErrorMessage(message: string | undefined) {
  const known = [
    "Hanafy platform access required",
    "Workspace not found",
    "Unknown service",
    "Unknown role",
    "needs",
    "Turn off",
    "Give a reason",
    "Keep the reason",
    "Choose ",
    "The end date",
    "At least one active owner",
    "No account uses that email",
    "Say why",
    "Support sessions last",
    "Ticket reference",
    "archived",
    "Only a platform owner",
    "Support session not found",
    "Sending number not found",
    "Enter the new number",
    "Switch this business",
    "is planned, not built",
    "does not support the",
    "CARD_DATA_REFUSED",
    "shows connected only after",
    "That location does not belong",
    "Payment connection not found",
    "messaging_identities_number_owner",
    "HARDWARE_SECRET_REFUSED",
    "Admin → Hardware",
    "is not valid",
    "Port must be",
    "Pick a device type",
    "Device not found",
    "does not exist at that location",
    "Only a payment terminal device",
    "That card terminal does not belong",
    "Caller lines can only be served",
    "Amounts ",
    "more than the",
    "draft",
    "Add at least one line",
    "Void the payments",
    "already void",
    "Enter the amount",
    "Enter the charge",
    "A credit cannot",
    "Plan not found",
    "Agreement not found",
    "Invoice not found",
    "Equipment not found",
    "That device does not belong",
    "Payment not found",
    "Payments can only be recorded",
    "Unknown service",
    "Enter the business name",
    "The web name",
    "That web name is reserved",
    "already uses the web name",
    "Unknown time zone",
    "Currency is",
    "first location",
    "needs ",
    "Opening time",
    "Closing time",
    "Not ready to go live",
    "stays archived",
    "cannot be archived",
    "Choose active",
  ];
  if (message?.includes("messaging_identities_number_owner")) return "That phone number already belongs to a business on the platform.";
  if (message?.includes("workspace_subscriptions_one_base")) return "This business already has a live base agreement. Change or cancel it, or add this as an add-on.";
  if (message?.includes("platform_plans_code_key")) return "A plan with that code already exists.";
  if (message?.includes("equipment_assets_one_per_device")) return "That device already has an equipment record.";
  if (message?.includes("hardware_devices_asset_tag_unique")) return "That asset tag is already used by another device of this business.";
  if (message?.includes("payment_connections_one_live")) return "This location already has a live payment connection for that purpose. Turn the old one off first.";
  if (message && known.some((part) => message.includes(part))) return message;
  return "The change could not be saved. Refresh and try again.";
}
