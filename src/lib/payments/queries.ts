import "server-only";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  checkoutPaymentConfigSchema, orderPaymentSchema, paymentConsoleSchema,
  paymentReconciliationSchema, type OrderPayment,
} from "./schemas";

/** Non-secret card configuration for the storefront. Never throws: no card, no checkout change. */
export async function getCheckoutPaymentConfig() {
  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("wayne_payment_checkout_config");
    if (error) return null;
    const parsed = checkoutPaymentConfigSchema.safeParse(data);
    return parsed.success && parsed.data.online_card_enabled ? parsed.data : null;
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
  const [settings, terminals] = await Promise.all([
    supabase.from("payment_provider_settings").select("terminal_card_enabled").eq("id", true).maybeSingle(),
    supabase.from("payment_terminals").select("id, label, device_id, status").eq("status", "active").order("label"),
  ]);
  if (!settings.data?.terminal_card_enabled) return [];
  return (terminals.data ?? []).map((terminal) => ({ id: terminal.id, label: terminal.label }));
}
