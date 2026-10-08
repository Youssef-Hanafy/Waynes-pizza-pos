import "server-only";

import { getCurrentAccess, type CurrentAccess } from "@/lib/auth/access";
import { isStoreOpenNow } from "@/lib/content/store-status";
import { getStorefront } from "@/lib/content/queries";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  checkoutPaymentConfigSchema, orderPaymentSchema, paymentConsoleSchema,
  paymentReconciliationSchema, type OrderPayment,
} from "./schemas";
import { paymentConnectionSummarySchema } from "./capabilities";
import { resolvePaymentProvider } from "./config";

/** Non-secret card configuration for the storefront. Never throws: no card, no checkout change. */
export async function getCheckoutPaymentConfig() {
  try {
    const storefront = await getStorefront();
    if (!storefront.known || !storefront.workspace || !storefront.services.includes("online_ordering")) return null;
    const resolved = await resolvePaymentProvider("online", {
      workspaceId: storefront.workspace.workspace_id,
      locationId: storefront.workspace.location_id,
    });
    if (!resolved.ok) return null;
    const candidate = resolved.value.provider.code === "stripe"
      ? { provider: "stripe", publishable_key: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, online_card_enabled: true }
      : resolved.value.settings;
    const parsed = checkoutPaymentConfigSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Non-secret Stripe configuration for the signed-in POS workspace. */
export async function getPosKeyedCardConfig() {
  try {
    const access = await getCurrentAccess();
    if (!access?.workspace_id) return null;
    const resolved = await resolvePaymentProvider("online", { workspaceId: access.workspace_id, locationId: access.location_id ?? null });
    if (!resolved.ok || resolved.value.provider.code !== "stripe") return null;
    const parsed = checkoutPaymentConfigSchema.safeParse({
      provider: "stripe", publishable_key: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, online_card_enabled: true,
    });
    return parsed.success && parsed.data.provider === "stripe" ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function getPaymentConsole() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_admin_payment_console");
  if (error) throw new Error("The payment console could not be loaded. Check the database connection and migrations.");
  return paymentConsoleSchema.parse(data);
}

export async function getPaymentReconciliation(from: string, through: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_payment_reconciliation", { from_date: from, through_date: through });
  if (error) throw new Error(`Payment reconciliation failed: ${error.message}`);
  return paymentReconciliationSchema.parse(data);
}

/** Payments on one order, with the refunded total already applied. */
export async function getOrderPayments(orderId: string): Promise<OrderPayment[]> {
  const supabase = await createServerSupabaseClient();
  const [payments, refunds] = await Promise.all([
    supabase.from("payments")
      .select("id, provider, provider_payment_id, method, status, provider_status, amount_cents, card_brand, card_last4, receipt_url, failure_reason, created_at")
      .eq("order_id", orderId).order("created_at", { ascending: false }),
    supabase.from("refunds").select("payment_id, amount_cents, status").eq("order_id", orderId),
  ]);
  if (payments.error || !payments.data) return [];
  const refunded = new Map<string, number>();
  for (const refund of refunds.data ?? []) {
    if (refund.status !== "completed" && refund.status !== "pending") continue;
    refunded.set(refund.payment_id, (refunded.get(refund.payment_id) ?? 0) + refund.amount_cents);
  }
  return payments.data.flatMap((row) => {
    const parsed = orderPaymentSchema.safeParse({ ...row, refunded_cents: refunded.get(row.id) ?? 0 });
    return parsed.success ? [parsed.data] : [];
  });
}

/** Card readers the counter may charge. Returns nothing when reader payment is off. */
export async function getPosTerminals() {
  const supabase = await createServerSupabaseClient();
  const access = await getCurrentAccess();
  if (!access?.workspace_id) return [];
  const [settings, terminals] = await Promise.all([
    supabase.from("location_payment_configurations").select("terminal_card_enabled").eq("workspace_id", access.workspace_id).order("created_at").limit(1).maybeSingle(),
    supabase.from("payment_terminals").select("id, label, device_id, status").eq("workspace_id", access.workspace_id).eq("status", "active").eq("terminal_type", "provider_reader").order("label"),
  ]);
  if (!settings.data?.terminal_card_enabled) return [];
  return (terminals.data ?? []).map((terminal) => ({ id: terminal.id, label: terminal.label }));
}

/**
 * The POS needs this independently of the Hardware screen.  A counter reader
 * that has already been authorised must not disappear merely because an old
 * counter WebView still has a stale hardware page in its cache.
 */
export async function getPosStripeReaderEnabled(scope?: Pick<CurrentAccess, "workspace_id" | "location_id">) {
  const supabase = await createServerSupabaseClient();
  const access = scope ?? await getCurrentAccess();
  if (!access?.workspace_id) return false;
  let query = supabase
    .from("location_payment_configurations")
    .select("provider,terminal_card_enabled")
    .eq("workspace_id", access.workspace_id);
  if (access.location_id) query = query.eq("location_id", access.location_id);
  const { data, error } = await query.order("created_at").limit(1).maybeSingle();
  return !error && data?.provider === "stripe" && data.terminal_card_enabled === true;
}

/**
 * Whether customers can order online right now.  Online ordering is open when
 * the store is open and there is a way to take the order: card payment is
 * live, or TEST / MANUAL (no-payment) ordering is switched on.  Turning TEST
 * ordering off at go-live must not close the storefront while cards are live.
 */
export async function isOnlineOrderingAvailable(settings: Parameters<typeof isStoreOpenNow>[0] & { test_ordering_enabled: boolean }, paymentConfig?: Awaited<ReturnType<typeof getCheckoutPaymentConfig>>) {
  if (!isStoreOpenNow(settings)) return false;
  if (settings.test_ordering_enabled) return true;
  const card = paymentConfig === undefined ? await getCheckoutPaymentConfig() : paymentConfig;
  return card !== null;
}

/** The business's payment connections (Phase 9), without secrets or webhook keys. */
export async function getPaymentConnectionsSummary(workspaceSlug: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_payment_connections_summary", { target_workspace_slug: workspaceSlug });
  if (error) return [];
  const parsed = paymentConnectionSummarySchema.array().safeParse(data ?? []);
  return parsed.success ? parsed.data : [];
}
