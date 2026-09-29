import "server-only";

import { z } from "zod";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { createSquareProvider, type SquareConfig } from "./square";
import { createStripeProvider, type StripeConfig } from "./stripe";
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

export async function readPaymentSettings(): Promise<PaymentProviderSettings | null> {
  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("payment_provider_settings")
    .select("provider, environment, application_id, location_id, notification_url, online_card_enabled, terminal_card_enabled, updated_at")
    .eq("id", true)
    .maybeSingle();
  if (error || !data) return null;
  const parsed = paymentProviderSettingsSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export type ResolvedProvider = { provider: PaymentProvider; settings: PaymentProviderSettings };

/**
 * Returns a live provider only when everything a real charge needs is present:
 * a chosen provider, its identifiers, and the server-side secrets. Anything missing
 * means card payment simply does not exist for this deployment — nothing is faked.
 */
export async function resolvePaymentProvider(channel: "online" | "terminal"): Promise<
  { ok: true; value: ResolvedProvider } | { ok: false; reason: string }
> {
  const settings = await readPaymentSettings();
  if (!settings || settings.provider === "none") return { ok: false, reason: "No payment provider is configured." };
  if (channel === "online" && !settings.online_card_enabled) return { ok: false, reason: "Card payment is switched off." };
  if (channel === "terminal" && !settings.terminal_card_enabled) return { ok: false, reason: "Card reader payment is switched off." };

  if (settings.provider === "stripe") {
    if (channel === "terminal") return { ok: false, reason: "Stripe Terminal is not configured yet." };
    const secrets = stripeSecretsSchema.safeParse({ STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET });
    if (!secrets.success) return { ok: false, reason: "Stripe credentials or the verified webhook secret are not installed on the server." };
    const config: StripeConfig = { secretKey: secrets.data.STRIPE_SECRET_KEY, webhookSecret: secrets.data.STRIPE_WEBHOOK_SECRET };
    return { ok: true, value: { provider: createStripeProvider(config), settings } };
  }

  const secrets = secretsSchema.safeParse({ SQUARE_ACCESS_TOKEN: process.env.SQUARE_ACCESS_TOKEN, SQUARE_WEBHOOK_SIGNATURE_KEY: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY });
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
export async function resolveWebhookProvider() {
  const settings = await readPaymentSettings();
  if (!settings || settings.provider === "none") return null;
  if (settings.provider === "stripe") {
    const secrets = stripeSecretsSchema.safeParse({ STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET });
    if (!secrets.success) return null;
    return { settings, provider: createStripeProvider({ secretKey: secrets.data.STRIPE_SECRET_KEY, webhookSecret: secrets.data.STRIPE_WEBHOOK_SECRET }) };
  }
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
