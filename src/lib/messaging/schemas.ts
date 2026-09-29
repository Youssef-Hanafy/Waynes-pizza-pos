import { z } from "zod";

const timestamp = z.string().min(1);

export const marketingConnectionSchema = z.object({
  id: z.uuid(),
  status: z.enum(["provisioning", "sandbox", "active", "suspended", "error"]),
  dispatch_mode: z.enum(["platform", "legacy_crm_bridge"]),
  live_sending: z.boolean(),
  aws_region: z.string().nullable(),
  registration_status: z.string().nullable(),
  production_access_status: z.string().nullable(),
  last_success_at: timestamp.nullable(),
  last_error_at: timestamp.nullable(),
});

export const campaignStatusSchema = z.enum(["draft", "scheduled", "sending", "sent", "cancelled", "failed"]);

export const campaignSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: campaignStatusSchema,
  channel: z.enum(["sms", "email"]),
  audience_type: z.enum(["all_subscribers", "segment"]),
  segment_id: z.uuid().nullable(),
  template_id: z.uuid().nullable(),
  body: z.string(),
  scheduled_at: timestamp.nullable(),
  started_at: timestamp.nullable(),
  finished_at: timestamp.nullable(),
  recipients_total: z.number().int(),
  recipients_skipped: z.number().int(),
  messages_sent: z.number().int(),
  messages_failed: z.number().int(),
  created_at: timestamp,
});
export type Campaign = z.infer<typeof campaignSchema>;

export const marketingOverviewSchema = z.object({
  workspace_id: z.uuid(),
  can_manage: z.boolean(),
  can_manage_suppressions: z.boolean(),
  connection: marketingConnectionSchema.nullable(),
  senders: z.array(z.object({ id: z.uuid(), phone_number: z.string(), status: z.string(), is_default: z.boolean(), message_type: z.string() })),
  subscribers: z.number().int(),
  suppressed: z.number().int(),
  suppressions: z.array(z.object({ id: z.uuid(), address: z.string(), reason: z.string(), note: z.string(), created_at: timestamp })),
  segments: z.array(z.object({ id: z.uuid(), name: z.string(), members: z.number().int() })),
  templates: z.array(z.object({ id: z.uuid(), name: z.string(), body: z.string(), channel: z.string(), message_type: z.string(), updated_at: timestamp })),
  campaigns: z.array(campaignSchema),
  recent_messages: z.array(z.object({
    id: z.uuid(),
    status: z.string(),
    skip_reason: z.string().nullable(),
    recipient_last4: z.string(),
    message_type: z.string(),
    campaign_id: z.uuid().nullable(),
    automation_run_id: z.uuid().nullable(),
    is_test: z.boolean(),
    simulated: z.boolean(),
    created_at: timestamp,
    sent_at: timestamp.nullable(),
    last_error: z.string().nullable(),
  })),
  legacy_crm: z.object({ business_slug: z.string() }).nullable(),
});
export type MarketingOverview = z.infer<typeof marketingOverviewSchema>;

export const audienceSchema = z.object({
  total: z.number().int(),
  eligible: z.number().int(),
  skipped: z.record(z.string(), z.number().int()),
});

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
export const campaignFormSchema = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(1, "Name the campaign.").max(120),
    audience_type: z.enum(["all_subscribers", "segment"]),
    segment_id: z.uuid().optional(),
    template_id: z.uuid().optional(),
    body: z.string().max(1600, "Keep the text under 1,600 characters."),
  })
  .refine((value) => value.audience_type !== "segment" || value.segment_id, { message: "Pick a segment.", path: ["segment_id"] })
  .refine((value) => value.body.trim().length > 0 || value.template_id, { message: "Write the message or pick a template.", path: ["body"] });

export const templateFormSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, "Name the template.").max(120),
  body: z.string().trim().min(1, "Write the message.").max(1600),
  message_type: z.enum(["marketing", "transactional"]).default("marketing"),
});

/** US mobile numbers typed any common way, returned as +1XXXXXXXXXX. */
export function normalizeUsPhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(national) ? `+1${national}` : null;
}

export const skipReasonLabels: Record<string, string> = {
  service_disabled: "Texting is off for this business",
  customer_not_in_workspace: "Not this business's customer",
  customer_removed: "Customer was erased",
  no_consent: "Not subscribed to texts",
  suppressed: "Opted out (STOP)",
  no_recipient: "No phone number",
};

/** Readable text for the database's messaging errors. */
export function messagingErrorMessage(message: string): string {
  if (message.includes("LEGACY_CRM_SENDS")) return "This business still sends texts from the Hanafy CRM console. Send it there for now, or ask Hanafy to switch texting to the platform.";
  if (message.includes("NO_SENDER")) return "This business has no active sending number yet. Hanafy sets one up in Platform Admin → Messaging.";
  if (message.includes("SENDER_CONNECTION_INACTIVE")) return "The texting connection is not active. Ask Hanafy to check Platform Admin → Messaging.";
  if (message.includes("SENDER_NOT_IN_WORKSPACE")) return "That sending number does not belong to this business.";
  if (message.includes("SERVICE_DISABLED")) return "Texting is not switched on for this business.";
  if (message.includes("EMAIL_NOT_AVAILABLE")) return "Email sending is not connected yet.";
  if (message.includes("permission")) return "You do not have permission to do that.";
  return message.length < 200 ? message : "That did not work. Try again.";
}

/** Placeholders the Campaign Manager fills in per customer. */
export const campaignPlaceholders = ["{{first_name}}", "{{last_name}}", "{{business_name}}"] as const;
