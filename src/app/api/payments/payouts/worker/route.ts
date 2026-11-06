import { timingSafeEqual } from "node:crypto";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { runCloseoutPayout } from "@/lib/payments/closeout-payout-worker";
import { logger } from "@/lib/logging/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const service = createServiceSupabaseClient();
  const { data: secret, error } = await service.from("scheduled_job_tokens").select("token").eq("name", "closeout_bank_payouts").maybeSingle();
  const presented = Buffer.from(request.headers.get("x-wayne-job-token") ?? "");
  const expected = Buffer.from(secret?.token ?? "");
  if (error || expected.length < 32 || presented.length !== expected.length || !timingSafeEqual(presented, expected)) return Response.json({ error: "Not allowed." }, { status: 401 });
  try {
    return Response.json(await runCloseoutPayout(service), { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logger.error("payout.worker_failed", cause);
    return Response.json({ error: "Bank payout worker could not finish." }, { status: 503 });
  }
}

/** Deployment preflight: read-only, authenticated with the scheduler's secret.
 * No Stripe keys or customer/payment data are returned.
 */
export async function GET(request: Request) {
  const service = createServiceSupabaseClient();
  const { data: secret } = await service.from("scheduled_job_tokens").select("token").eq("name", "closeout_bank_payouts").maybeSingle();
  const presented = Buffer.from(request.headers.get("x-wayne-job-token") ?? "");
  const expected = Buffer.from(secret?.token ?? "");
  if (expected.length < 32 || expected.length !== presented.length || !timingSafeEqual(expected, presented)) return Response.json({ error: "Not allowed." }, { status: 401 });
  const id = new URL(request.url).searchParams.get("connection_id");
  if (!id || !/^[a-f0-9-]{36}$/i.test(id)) return Response.json({ error: "Connection required." }, { status: 400 });
  const { data: connection } = await service.from("payment_connections").select("provider,secret_reference,environment").eq("id", id).maybeSingle();
  if (connection?.provider !== "stripe") return Response.json({ error: "Stripe connection required." }, { status: 400 });
  const { stripeSecrets } = await import("@/lib/payments/capabilities");
  const { createCloseoutStripe } = await import("@/lib/payments/closeout-payout");
  const secrets = stripeSecrets(connection.secret_reference);
  if (!secrets) return Response.json({ error: "Stripe credentials unavailable." }, { status: 503 });
  try {
    const account = await createCloseoutStripe(secrets.secretKey).account();
    return Response.json({ account_id: account.id, name: account.business_profile?.name, payouts_enabled: account.payouts_enabled,
      environment: connection.environment, key_mode: secrets.secretKey.startsWith("sk_live_") ? "production" : "sandbox",
      schedule: account.settings.payouts.schedule.interval, default_currency: account.default_currency, bank_lookup_available: account.bankLookupAvailable,
      banks: account.banks.map(({ id, object, currency, default_for_currency, status, bank_name, last4 }) => ({ id, object, currency, default_for_currency, status, bank_name, last4 })) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Stripe payout settings could not be read." }, { status: 503 });
  }
}
