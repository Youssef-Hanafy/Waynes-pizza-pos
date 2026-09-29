import { z } from "zod";
import { paymentCapabilitiesSchema } from "@/lib/payments/capabilities";

/** Platform Admin → Integrations (Phase 9, §11.3 Payments, §24). */
const timestamp = z.string();
const count = z.coerce.number().int().nonnegative();

export const platformIntegrationsSchema = z.object({
  can_manage: z.boolean(),
  integrations: z.array(z.object({
    id: z.uuid(), type: z.string(), provider: z.string(), status: z.string(), name: z.string(), location_id: z.uuid().nullable(),
    verified_at: timestamp.nullable(), last_success_at: timestamp.nullable(), last_error_at: timestamp.nullable(),
    last_error_summary: z.string().nullable(), updated_at: timestamp,
  })),
  payment_connections: z.array(z.object({
    id: z.uuid(), purpose: z.enum(["counter", "online", "counter_and_online"]), provider: z.string(), provider_name: z.string(),
    connection_mode: z.enum(["api", "terminal_api", "hosted_checkout", "manual_external"]),
    status: z.enum(["not_configured", "pending_verification", "connected", "manual", "error", "disabled"]),
    environment: z.enum(["sandbox", "production"]), merchant_reference: z.string().nullable(), capabilities: paymentCapabilitiesSchema,
    public_configuration: z.record(z.string(), z.unknown()), secret_reference: z.string().nullable(), webhook_path: z.string().nullable(),
    location_id: z.uuid().nullable(), location_name: z.string().nullable(), verified_at: timestamp.nullable(), verification_note: z.string().nullable(),
    last_success_at: timestamp.nullable(), last_error_at: timestamp.nullable(), last_error_summary: z.string().nullable(),
    terminals: z.array(z.object({ id: z.uuid(), label: z.string(), type: z.string(), status: z.string(), last_used_at: timestamp.nullable() })),
  })),
  providers: z.array(z.object({
    code: z.string(), name: z.string(), availability: z.enum(["available", "planned"]), connection_modes: z.array(z.string()),
    capabilities: paymentCapabilitiesSchema, description: z.string(),
  })),
  locations: z.array(z.object({ id: z.uuid(), name: z.string() })),
  last_card_payment_at: timestamp.nullable(),
  webhook_problems_7d: count,
});
export type PlatformIntegrations = z.infer<typeof platformIntegrationsSchema>;

const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

export const savePaymentConnectionInputSchema = z.object({
  workspace: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(500),
  confirmed: z.boolean(),
  payload: z.object({
    id: z.preprocess(blank, z.uuid().optional()),
    provider: z.preprocess(blank, z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).optional()),
    purpose: z.preprocess(blank, z.enum(["counter", "online", "counter_and_online"]).optional()),
    connection_mode: z.preprocess(blank, z.enum(["api", "terminal_api", "hosted_checkout", "manual_external"]).optional()),
    status: z.preprocess(blank, z.enum(["not_configured", "pending_verification", "manual", "disabled"]).optional()),
    environment: z.preprocess(blank, z.enum(["sandbox", "production"]).optional()),
    merchant_reference: z.preprocess(blank, z.string().max(200).optional()),
    location_id: z.preprocess(blank, z.uuid().optional()),
    secret_reference: z.preprocess(blank, z.string().regex(/^env:[A-Z][A-Z0-9_]{1,40}$/, "Secret reference looks like env:SQUARE_WAYNES.").optional()),
    terminal_label: z.preprocess(blank, z.string().max(120).optional()),
    public_configuration: z.record(z.string(), z.union([z.string().max(300), z.boolean()])).optional(),
  }).refine((value) => value.id || value.provider, { message: "Pick a provider." }),
});
export type SavePaymentConnectionInput = z.infer<typeof savePaymentConnectionInputSchema>;
export const savePaymentConnectionResultSchema = z.object({ status: z.enum(["saved", "needs_confirmation"]), warnings: z.array(z.string()), id: z.uuid().optional() });

export const connectionStatusLabels: Record<string, string> = {
  not_configured: "Not configured",
  pending_verification: "Waiting for a connection test",
  pending: "Pending",
  connected: "Connected (tested)",
  manual: "Manual (person-run terminal)",
  active: "Active",
  error: "Error",
  disabled: "Off",
};
