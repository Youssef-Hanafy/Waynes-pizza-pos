import "server-only";

import { headers } from "next/headers";
import { z } from "zod";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { createSquareProvider, type SquareConfig } from "./square";
import type { PaymentProvider } from "./provider";
import { paymentProviderSettingsSchema, type PaymentProviderSettings } from "./schemas";

const secretsSchema = z.object({
  SQUARE_ACCESS_TOKEN: z.string().min(10),
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().min(10),
});

/** True only when the server actually holds the processor secrets. */
export function paymentSecretsPresent() {
  return secretsSchema.safeParse({
    SQUARE_ACCESS_TOKEN: process.env.SQUARE_ACCESS_TOKEN,
    SQUARE_WEBHOOK_SIGNATURE_KEY: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
  }).success;
}

function normalizedHost(value: string) {
  return value.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.+$/, "");
}

/**
 * Whose payment connection to use.  Staff paths pass their signed-in
 * workspace; public paths pass the storefront's workspace/location; only a
 * provider webhook still resolves by host (per-connection URLs arrive with
 * the Phase 9 integration registry).  There is never a fallback business.
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

export type ResolvedProvider = { provider: PaymentProvider; settings: PaymentProviderSettings };

/**
 * Returns a live provider only when everything a real charge needs is present:
 * a chosen provider, its identifiers, and the server-side secrets. Anything missing
 * means card payment simply does not exist for this deployment — nothing is faked.
 */
export async function resolvePaymentProvider(channel: "online" | "terminal", scope?: PaymentScope): Promise<
  { ok: true; value: ResolvedProvider } | { ok: false; reason: string }
> {
  const settings = await readPaymentSettings(scope);
  if (!settings || settings.provider === "none") return { ok: false, reason: "No payment provider is configured." };
  if (channel === "online" && !settings.online_card_enabled) return { ok: false, reason: "Card payment is switched off." };
  if (channel === "terminal" && !settings.terminal_card_enabled) return { ok: false, reason: "Card reader payment is switched off." };

  const secrets = secretsSchema.safeParse({
    SQUARE_ACCESS_TOKEN: process.env.SQUARE_ACCESS_TOKEN,
    SQUARE_WEBHOOK_SIGNATURE_KEY: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
  });
  if (!secrets.success) return { ok: false, reason: "The processor credentials are not installed on the server." };
  if (!settings.application_id || !settings.location_id) return { ok: false, reason: "The processor is not fully configured." };

  const config: SquareConfig = {
    accessToken: secrets.data.SQUARE_ACCESS_TOKEN,
    environment: settings.environment,
    applicationId: settings.application_id,
    locationId: settings.location_id,
    notificationUrl: settings.notification_url,
    webhookSignatureKey: secrets.data.SQUARE_WEBHOOK_SIGNATURE_KEY,
  };
  return { ok: true, value: { provider: createSquareProvider(config), settings } };
}

/** The webhook receiver needs the provider even when the switches are off. */
export async function resolveWebhookProvider(host?: string) {
  const settings = await readPaymentSettings(host === undefined ? undefined : { host });
  if (!settings || settings.provider === "none") return null;
  const secrets = secretsSchema.safeParse({
    SQUARE_ACCESS_TOKEN: process.env.SQUARE_ACCESS_TOKEN,
    SQUARE_WEBHOOK_SIGNATURE_KEY: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
  });
  if (!secrets.success) return null;
  return {
    settings,
    provider: createSquareProvider({
      accessToken: secrets.data.SQUARE_ACCESS_TOKEN,
      environment: settings.environment,
      applicationId: settings.application_id,
      locationId: settings.location_id,
      notificationUrl: settings.notification_url,
      webhookSignatureKey: secrets.data.SQUARE_WEBHOOK_SIGNATURE_KEY,
    }),
  };
}
