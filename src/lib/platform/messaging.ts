import { z } from "zod";

/** Platform Admin → Messaging (Phase 7, §11.3). Shapes only; the database checks the role. */
const timestamp = z.string();
const count = z.coerce.number().int().nonnegative();

export const platformMessagingSchema = z.object({
  connection: z.object({
    id: z.uuid(),
    provider: z.string(),
    status: z.enum(["provisioning", "sandbox", "active", "suspended", "error"]),
    aws_region: z.string().nullable(),
    provider_account_ref: z.string().nullable(),
    registration_status: z.string().nullable(),
    production_access_status: z.string().nullable(),
    dispatch_mode: z.enum(["platform", "legacy_crm_bridge"]),
    live_sending: z.boolean(),
    secret_reference: z.string().nullable(),
    last_success_at: timestamp.nullable(),
    last_error_at: timestamp.nullable(),
    last_error_summary: z.string().nullable(),
    updated_at: timestamp,
  }).nullable(),
  identities: z.array(z.object({
    id: z.uuid(),
    phone_number: z.string(),
    provider_identity_arn: z.string().nullable(),
    identity_type: z.string().nullable(),
    message_type: z.string(),
    status: z.string(),
    is_default: z.boolean(),
    location_id: z.uuid().nullable(),
    legacy: z.boolean(),
  })),
  usage: z.object({ sent_24h: count, sent_30d: count, simulated_30d: count, failed_30d: count, skipped_30d: count, unknown: count, queued: count }),
  recent_failures: z.array(z.object({ id: z.uuid(), at: timestamp, status: z.string(), recipient_last4: z.string(), error: z.string().nullable() })),
  opt_outs: count,
  subscribers: count,
  campaigns: count,
  legacy_crm: z.object({ project_ref: z.string(), business_id: z.uuid(), business_slug: z.string(), notes: z.string() }).nullable(),
  can_manage: z.boolean(),
});
export type PlatformMessaging = z.infer<typeof platformMessagingSchema>;

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export const saveMessagingInputSchema = z.object({
  workspace: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500),
  confirmed: z.boolean(),
  payload: z.object({
    status: z.enum(["provisioning", "sandbox", "active", "suspended", "error"]).optional(),
    aws_region: z.preprocess(blankToUndefined, z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d$/, "Region looks like us-east-1.").optional()),
    provider_account_ref: z.preprocess(blankToUndefined, z.string().max(200).optional()),
    registration_status: z.preprocess(blankToUndefined, z.enum(["not_started", "submitted", "approved", "rejected", "not_required"]).optional()),
    production_access_status: z.preprocess(blankToUndefined, z.enum(["sandbox", "requested", "granted", "denied"]).optional()),
    dispatch_mode: z.enum(["platform", "legacy_crm_bridge"]).optional(),
    live_sending: z.boolean().optional(),
    secret_reference: z.preprocess(blankToUndefined, z.string().regex(/^env:[A-Z][A-Z0-9_]{1,40}$/, "Secret reference looks like env:WAYNES_SMS.").optional()),
    identity: z.object({
      id: z.preprocess(blankToUndefined, z.uuid().optional()),
      phone_number: z.preprocess(blankToUndefined, z.string().regex(/^\+[1-9]\d{7,14}$/, "Phone number in +1 format.").optional()),
      provider_identity_arn: z.preprocess(blankToUndefined, z.string().max(300).optional()),
      identity_type: z.preprocess(blankToUndefined, z.enum(["long_code", "ten_dlc", "toll_free", "short_code"]).optional()),
      message_type: z.enum(["PROMOTIONAL", "TRANSACTIONAL"]).optional(),
      status: z.enum(["pending", "active", "suspended", "retired"]).optional(),
      is_default: z.boolean().optional(),
    }).optional(),
  }),
});
export type SaveMessagingInput = z.infer<typeof saveMessagingInputSchema>;

export const saveMessagingResultSchema = z.object({ status: z.enum(["saved", "needs_confirmation"]), warnings: z.array(z.string()) });
