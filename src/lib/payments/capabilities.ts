import { z } from "zod";

/**
 * Phase 9 capability model (§20.4/20.5).  A workspace's payment connection
 * says which provider and mode it uses; its capabilities come from the
 * platform's provider catalog, never from the browser.  Order code asks
 * "can this connection do X?" and never names a processor.
 */
export const paymentCapabilitiesSchema = z.object({
  online_card: z.boolean().default(false),
  card_present: z.boolean().default(false),
  card_present_integrated: z.boolean().default(false),
  manual_confirmation: z.boolean().default(false),
  refunds_via_api: z.boolean().default(false),
  voids_via_api: z.boolean().default(false),
  webhooks: z.boolean().default(false),
});
export type PaymentCapabilities = z.infer<typeof paymentCapabilitiesSchema>;

export const paymentConnectionSchema = z.object({
  id: z.uuid(),
  workspace_id: z.uuid(),
  location_id: z.uuid().nullable(),
  provider: z.string(),
  connection_mode: z.enum(["api", "terminal_api", "hosted_checkout", "manual_external"]),
  status: z.enum(["not_configured", "pending_verification", "connected", "manual", "error", "disabled"]),
  environment: z.enum(["sandbox", "production"]),
  merchant_reference: z.string().nullable(),
  capabilities: paymentCapabilitiesSchema,
  public_configuration: z.record(z.string(), z.unknown()),
  secret_reference: z.string().nullable(),
  purpose: z.enum(["counter", "online", "counter_and_online"]),
});
export type PaymentConnection = z.infer<typeof paymentConnectionSchema>;

export type PaymentChannel = "online" | "terminal";

/** Whether this connection can take this kind of payment right now, and if not, why. */
export function capabilityGate(connection: PaymentConnection, channel: PaymentChannel): { ok: true } | { ok: false; reason: string; manual?: true } {
  if (connection.status === "disabled" || connection.status === "not_configured") return { ok: false, reason: "No payment provider is configured." };
  if (connection.status === "error") return { ok: false, reason: "The payment connection has an error. Hanafy is checking it." };
  if (connection.connection_mode === "manual_external") {
    return channel === "terminal"
      ? { ok: false, manual: true, reason: "Card payments are taken on the store's own card terminal. Run the amount there and confirm." }
      : { ok: false, reason: "Online card payment is not available for this business." };
  }
  const config = connection.public_configuration;
  if (channel === "online") {
    if (!connection.capabilities.online_card) return { ok: false, reason: "This payment connection cannot take online cards." };
    if (config.online_card_enabled !== true) return { ok: false, reason: "Card payment is switched off." };
  } else {
    if (!connection.capabilities.card_present_integrated) return { ok: false, reason: "This payment connection cannot drive a card reader." };
    if (config.terminal_card_enabled !== true) return { ok: false, reason: "Card reader payment is switched off." };
  }
  return { ok: true };
}

/**
 * Provider secrets named by a connection's secret_reference (env:PREFIX),
 * read from the server environment only.
 */
export function providerSecrets(secretReference: string | null, env: NodeJS.ProcessEnv = process.env) {
  const match = secretReference?.match(/^env:([A-Z][A-Z0-9_]{1,40})$/);
  if (!match) return null;
  const prefix = match[1];
  const accessToken = env[`${prefix}_ACCESS_TOKEN`];
  const webhookSignatureKey = env[`${prefix}_WEBHOOK_SIGNATURE_KEY`];
  if (!accessToken || accessToken.length < 10 || !webhookSignatureKey || webhookSignatureKey.length < 10) return null;
  return { accessToken, webhookSignatureKey };
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The Square settings a connection carries (public identifiers only). */
export function squarePublicConfig(connection: PaymentConnection) {
  const config = connection.public_configuration;
  return {
    applicationId: text(config.application_id),
    locationId: text(config.provider_location_id) || connection.merchant_reference || "",
    notificationUrl: text(config.notification_url),
  };
}

/** What a business's own Payments screen shows about its connections. */
export const paymentConnectionSummarySchema = z.object({
  id: z.uuid(),
  purpose: z.enum(["counter", "online", "counter_and_online"]),
  provider: z.string(),
  provider_name: z.string(),
  connection_mode: z.enum(["api", "terminal_api", "hosted_checkout", "manual_external"]),
  status: z.enum(["not_configured", "pending_verification", "connected", "manual", "error", "disabled"]),
  environment: z.enum(["sandbox", "production"]),
  merchant_reference: z.string().nullable(),
  capabilities: paymentCapabilitiesSchema,
  location_name: z.string().nullable(),
  last_success_at: z.string().nullable(),
  terminals: z.array(z.object({ label: z.string(), type: z.string(), status: z.string() })),
});
export type PaymentConnectionSummary = z.infer<typeof paymentConnectionSummarySchema>;
