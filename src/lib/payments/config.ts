import "server-only";

import { headers } from "next/headers";
import { z } from "zod";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { paymentConnectionSchema, squarePublicConfig, type PaymentConnection } from "./capabilities";
import { buildPaymentAdapter, buildWebhookProvider } from "./registry";
import type { PaymentProvider } from "./provider";
import { paymentProviderSettingsSchema, type PaymentProviderSettings } from "./schemas";

const secretsSchema = z.object({
  SQUARE_ACCESS_TOKEN: z.string().min(10),
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().min(10),
});

const stripeSecretsSchema = z.object({
  STRIPE_SECRET_KEY: z.string().startsWith("sk_").min(20),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_").min(20),
});

/** True only when the server actually holds the processor secrets. */
export function paymentSecretsPresent(provider?: "none" | "square" | "stripe"): boolean {
  if (provider === "stripe") return stripeSecretsSchema.safeParse({ STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET }).success;
  if (provider === "square") return secretsSchema.safeParse({ SQUARE_ACCESS_TOKEN: process.env.SQUARE_ACCESS_TOKEN, SQUARE_WEBHOOK_SIGNATURE_KEY: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY }).success;
  return paymentSecretsPresent("stripe") || paymentSecretsPresent("square");
}

function normalizedHost(value: string) {
  return value.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.+$/, "");
}

/**
 * Whose payment connection to use.  Staff paths pass their signed-in
 * workspace; public paths pass the storefront's workspace/location; the old
 * host-routed webhook still resolves by host, and per-connection webhooks
 * (/api/payments/webhooks/[key]) by their key.  There is never a fallback business.
 */
export type PaymentScope = { workspaceId: string; locationId?: string | null } | { host: string };

export async function readPaymentSettings(scope?: PaymentScope): Promise<PaymentProviderSettings | null> {
  const supabase = createServiceSupabaseClient();
  let workspaceId: string | null = null;
  let locationId: string | null = null;
  if (scope && "workspaceId" in scope) {
    workspaceId = scope.workspaceId;
    locationId = scope.locationId ?? null;
  } else {
    const requestHost = scope?.host ?? (await headers()).get("x-forwarded-host") ?? (await headers()).get("host") ?? "";
    const { data: domain, error: domainError } = await supabase
      .from("workspace_domains")
      .select("workspace_id,location_id")
      .eq("hostname", normalizedHost(requestHost))
      .eq("active", true)
      .maybeSingle();
    if (domainError || !domain) return null;
    workspaceId = domain.workspace_id;
    locationId = domain.location_id;
  }
  let query = supabase
    .from("location_payment_configurations")
    .select("provider, environment, application_id, provider_location_id, notification_url, online_card_enabled, terminal_card_enabled, updated_at")
    .eq("workspace_id", workspaceId);
  if (locationId) query = query.eq("location_id", locationId);
  const { data, error } = await query.order("created_at").limit(1).maybeSingle();
  if (error || !data) return null;
  const parsed = paymentProviderSettingsSchema.safeParse({ ...data, location_id: data.provider_location_id });
  return parsed.success ? parsed.data : null;
}

export type ResolvedProvider = { provider: PaymentProvider; settings: PaymentProviderSettings; connection: PaymentConnection };

async function resolveScope(scope?: PaymentScope): Promise<{ workspaceId: string; locationId: string | null } | null> {
  if (scope && "workspaceId" in scope) return { workspaceId: scope.workspaceId, locationId: scope.locationId ?? null };
  const supabase = createServiceSupabaseClient();
  const requestHost = scope?.host ?? (await headers()).get("x-forwarded-host") ?? (await headers()).get("host") ?? "";
  const { data, error } = await supabase
    .from("workspace_domains")
    .select("workspace_id,location_id")
    .eq("hostname", normalizedHost(requestHost))
    .eq("active", true)
    .maybeSingle();
  if (error || !data) return null;
  return { workspaceId: data.workspace_id as string, locationId: (data.location_id as string | null) ?? null };
}

/**
 * The workspace's payment connection for a purpose (Phase 9).  Location
 * specific beats workspace-wide; there is never another workspace's
 * connection and never a fallback.
 */
export async function readPaymentConnection(purpose: "online" | "counter", scope?: PaymentScope): Promise<PaymentConnection | null> {
  const resolved = await resolveScope(scope);
  if (!resolved) return null;
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_payment_connection_for", {
    target_workspace_id: resolved.workspaceId,
    target_location_id: resolved.locationId,
    target_purpose: purpose,
  });
  if (error || !data) return null;
  const parsed = paymentConnectionSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

function settingsFromConnection(connection: PaymentConnection): PaymentProviderSettings {
  const config = squarePublicConfig(connection);
  return {
    provider: connection.provider === "square" || connection.provider === "stripe" ? connection.provider : "none",
    environment: connection.environment,
    application_id: config.applicationId,
    location_id: config.locationId,
    notification_url: config.notificationUrl,
    online_card_enabled: connection.capabilities.online_card && connection.public_configuration.online_card_enabled === true,
    terminal_card_enabled: connection.capabilities.card_present_integrated && connection.public_configuration.terminal_card_enabled === true,
    updated_at: new Date(0).toISOString(),
  };
}

/**
 * Returns a live provider only when the workspace's connection can do this
 * kind of payment, it is switched on, and the server holds that
 * connection's secrets.  The provider is chosen by the adapter registry;
 * callers only see the PaymentProvider interface.  A manual external
 * terminal (e.g. the store's own processor terminal) never returns a
 * provider: the POS asks a person to run the amount and confirm.
 */
export async function resolvePaymentProvider(channel: "online" | "terminal", scope?: PaymentScope): Promise<
  { ok: true; value: ResolvedProvider } | { ok: false; reason: string; manual?: true }
> {
  const connection = await readPaymentConnection(channel === "online" ? "online" : "counter", scope);
  if (!connection) return { ok: false, reason: "No payment provider is configured." };
  const built = buildPaymentAdapter(connection, channel);
  if (!built.ok) return built;
  return { ok: true, value: { provider: built.value.provider, settings: settingsFromConnection(connection), connection } };
}

/** Legacy host-routed webhook (/api/webhooks/square): the host's online connection. */
export async function resolveWebhookProvider(host?: string) {
  const connection = await readPaymentConnection("online", host === undefined ? undefined : { host });
  if (!connection) return null;
  const provider = buildWebhookProvider(connection);
  if (!provider) return null;
  return { settings: settingsFromConnection(connection), provider, connection };
}
