import "server-only";
import type { createServiceSupabaseClient } from "@/lib/supabase/server";
import { PaymentProviderError, type PaymentProvider, type ProviderPayment } from "./provider";

type Service = ReturnType<typeof createServiceSupabaseClient>;
export type PayarcAttempt = { payment_id: string; amount_cents: number; reference: string; duplicate: boolean; status: string; provider_payment_id?: string | null };

export async function settlePayarcPayment(service: Service, connectionId: string, payment: ProviderPayment) {
  if (!payment.providerPaymentId) throw new PaymentProviderError("The charge identity is missing. Review Payarc before paying again.", "PAYMENT_IDENTITY", true);
  const saved = await service.rpc("wayne_settle_payarc_payment", { target_connection_id: connectionId, payload: {
    provider_payment_id: payment.providerPaymentId, reference: payment.metadata?.wayne_payarc_reference,
    status: payment.status, provider_status: payment.providerStatus, amount_cents: payment.amountCents,
    tip_amount: payment.tipAmountCents,
    card_brand: payment.cardBrand, card_last4: payment.cardLast4, failure_reason: payment.failureReason,
  } });
  if (saved.error) throw new PaymentProviderError("The payment needs reconciliation. Check Payarc before paying again.", "DATABASE", true);
  return saved.data as { payment_id: string; status: string };
}

/** A duplicate request only reads; it never submits a new charge or another token. */
export async function executePayarcPayment(service: Service, provider: PaymentProvider, connectionId: string, attempt: PayarcAttempt, sourceId: string, key: string) {
  if (attempt.duplicate) {
    if (!attempt.provider_payment_id) return { status: attempt.status, payment_id: attempt.payment_id };
    return settlePayarcPayment(service, connectionId, await provider.getPaymentStatus(attempt.provider_payment_id));
  }
  let payment: ProviderPayment;
  try {
    payment = await provider.createOnlinePayment({ amountCents: attempt.amount_cents, sourceId, idempotencyKey: key, referenceId: attempt.reference, note: "Wayne's payment" });
  } catch (error) {
    if (error instanceof PaymentProviderError && !error.retryable) {
      const failed = await service.rpc("wayne_settle_payment", { payload: { payment_id: attempt.payment_id, status: "failed", provider_status: error.code, failure_reason: error.message } });
      if (failed.error) throw new PaymentProviderError("The payment could not be finalized. Check it before retrying.", "DATABASE", true);
    }
    throw error;
  }
  // Bind a valid charge before re-reading, so a later reconciliation can recover.
  if (!payment.providerPaymentId || payment.metadata?.wayne_payarc_reference !== attempt.reference || (payment.status === "captured" && payment.amountCents !== attempt.amount_cents)) {
    throw new PaymentProviderError("The Payarc response does not match this payment. Review it before paying again.", "PAYMENT_IDENTITY", true);
  }
  await settlePayarcPayment(service, connectionId, { ...payment, status: "pending" });
  return settlePayarcPayment(service, connectionId, await provider.getPaymentStatus(payment.providerPaymentId));
}
