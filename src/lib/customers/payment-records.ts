import "server-only";

import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Admin → Customers → a customer's payment records (owner, 2026-10-19): for
 * every past order, how it was paid and any signature taken, so a dispute can
 * be answered from the profile.
 */
const n = z.coerce.number().int().catch(0);
const nullableText = z.string().nullable().optional().transform((value) => value ?? "");

export const customerPaymentRecordSchema = z.object({
  id: z.uuid(),
  order_number: z.string(),
  daily_number: z.number().int().nullable().optional().default(null),
  placed_at: z.string(),
  status: z.string(),
  source: z.string(),
  fulfillment_type: z.string(),
  payment_status: nullableText,
  payment_method: nullableText,
  subtotal_cents: n, tax_cents: n, delivery_fee_cents: n, discount_cents: n, tip_cents: n, total_cents: n,
  is_test: z.boolean().catch(false),
  payments: z.array(z.object({
    id: z.uuid(),
    method: nullableText, provider: nullableText, provider_payment_id: nullableText, status: nullableText,
    amount_cents: n, card_brand: nullableText, card_last4: nullableText, entry: nullableText, approval_code: nullableText,
    tip_cents: n, tendered_cents: z.number().int().nullable().optional().default(null), change_cents: z.number().int().nullable().optional().default(null),
    authorized_at: z.string().nullable().optional().default(null), captured_at: z.string().nullable().optional().default(null),
    failed_at: z.string().nullable().optional().default(null), failure_reason: nullableText, receipt_url: nullableText,
    created_at: z.string(), taken_by: nullableText,
  })).catch([]),
  refunds: z.array(z.object({ amount_cents: n, status: nullableText, reason: nullableText, created_at: z.string() })).catch([]),
  signatures: z.array(z.object({ id: z.uuid(), signature_svg: z.string(), tip_cents: n, signed_at: z.string() })).catch([]),
});
export type CustomerPaymentRecord = z.infer<typeof customerPaymentRecordSchema>;

export async function getCustomerPaymentRecords(customerId: string): Promise<CustomerPaymentRecord[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_admin_customer_payment_records", { target_customer_id: customerId, max_orders: 100 });
  if (error) throw new Error(`Payment records failed: ${error.message}`);
  return customerPaymentRecordSchema.array().parse(data ?? []);
}
