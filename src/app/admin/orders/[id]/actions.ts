"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/access";
import { logger } from "@/lib/logging/logger";
import { orderTransitionSchema, transitionErrorMessage } from "@/lib/orders/status";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { PaymentProviderError } from "@/lib/payments/provider";
import { parseAmountInput, paymentErrorMessage, refundRequestSchema } from "@/lib/payments/schemas";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server";

/** Admin order-detail status changes (hand-off, completion, cancellation). */
export async function changeOrderStatus(form: FormData) {
  const orderId = z.uuid().safeParse(form.get("order_id"));
  if (!orderId.success) redirect("/admin/orders");
  const path = `/admin/orders/${orderId.data}`;
  const nextStatus = String(form.get("next_status") ?? "");
  await requirePermission(nextStatus === "cancelled" ? "orders.cancel" : "orders.manage", path);
  if (nextStatus === "cancelled" && form.get("confirm") !== "on") redirect(`${path}?error=${encodeURIComponent("Tick the confirmation box to cancel this order.")}`);
  const parsed = orderTransitionSchema.safeParse({
    order_id: orderId.data,
    expected_status: form.get("expected_status"),
    next_status: nextStatus,
    reason: form.get("reason") ?? undefined,
  });
  if (!parsed.success) redirect(`${path}?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid order action.")}`);
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_transition_order", {
    target_order_id: parsed.data.order_id,
    expected_status: parsed.data.expected_status,
    next_status: parsed.data.next_status,
    reason: parsed.data.reason ?? null,
  });
  if (error) redirect(`${path}?error=${encodeURIComponent(transitionErrorMessage(error))}`);
  revalidatePath(path);
  revalidatePath("/admin/orders");
  revalidatePath("/admin");
  redirect(`${path}?saved=${parsed.data.next_status}`);
}

/**
 * Refund a captured card payment. The refund is opened in the ledger first, sent to
 * the processor second, and settled third, so a refund can never be "sent" without a
 * record and can never be recorded without being sent.
 */
export async function refundOrderPayment(form: FormData) {
  const orderId = z.uuid().safeParse(form.get("order_id"));
  if (!orderId.success) redirect("/admin/orders");
  const path = `/admin/orders/${orderId.data}`;
  await requirePermission("payments.manage", path);

  const amount = parseAmountInput(String(form.get("amount") ?? ""));
  if (!amount.ok) redirect(`${path}?error=${encodeURIComponent(amount.error)}`);
  const parsed = refundRequestSchema.safeParse({
    payment_id: form.get("payment_id"),
    amount_cents: amount.ok ? amount.cents : 0,
    reason: form.get("reason"),
    idempotency_key: String(form.get("idempotency_key") ?? ""),
  });
  if (!parsed.success) redirect(`${path}?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Check the refund details.")}`);

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_begin_refund", { payload: parsed.data });
  if (error) redirect(`${path}?error=${encodeURIComponent(paymentErrorMessage(error))}`);
  const begun = data as { refund_id: string; duplicate: boolean; provider_payment_id: string | null };
  if (begun.duplicate) redirect(`${path}?saved=refund_duplicate`);
  if (!begun.provider_payment_id) redirect(`${path}?error=${encodeURIComponent("That payment has no processor reference to refund.")}`);

  const resolved = await resolvePaymentProvider("online");
  if (!resolved.ok) redirect(`${path}?error=${encodeURIComponent("The payment processor is not available. The refund is recorded as pending.")}`);

  const service = createServiceSupabaseClient();
  try {
    const refund = await resolved.value.provider.refundPayment({
      providerPaymentId: begun.provider_payment_id!,
      amountCents: parsed.data.amount_cents,
      idempotencyKey: parsed.data.idempotency_key,
      reason: parsed.data.reason,
    });
    // PENDING is a real Square answer: the webhook completes it later.
    if (refund.status !== "pending") {
      await service.rpc("wayne_settle_refund", {
        payload: { refund_id: begun.refund_id, status: refund.status, provider_refund_id: refund.providerRefundId, provider_status: refund.providerStatus },
      });
    } else {
      await service.from("refunds").update({ provider_refund_id: refund.providerRefundId, provider_status: refund.providerStatus }).eq("id", begun.refund_id);
    }
  } catch (cause) {
    const message = cause instanceof PaymentProviderError ? cause.message : "The refund could not be sent to the card network.";
    if (cause instanceof PaymentProviderError && !cause.retryable) {
      await service.rpc("wayne_settle_refund", { payload: { refund_id: begun.refund_id, status: "failed", failure_reason: message } });
    }
    logger.error("refund.provider_failed", cause, { order_id: orderId.data });
    redirect(`${path}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath(path);
  revalidatePath("/admin/payments");
  redirect(`${path}?saved=refunded`);
}

/** Void an authorized-but-not-captured payment. */
export async function voidOrderPayment(form: FormData) {
  const orderId = z.uuid().safeParse(form.get("order_id"));
  if (!orderId.success) redirect("/admin/orders");
  const path = `/admin/orders/${orderId.data}`;
  await requirePermission("payments.manage", path);
  const paymentId = z.uuid().safeParse(form.get("payment_id"));
  const providerPaymentId = String(form.get("provider_payment_id") ?? "");
  if (!paymentId.success || !providerPaymentId) redirect(`${path}?error=${encodeURIComponent("That payment cannot be voided.")}`);

  const resolved = await resolvePaymentProvider("online");
  if (!resolved.ok) redirect(`${path}?error=${encodeURIComponent("The payment processor is not available.")}`);
  const service = createServiceSupabaseClient();
  try {
    const result = await resolved.value.provider.voidPayment(providerPaymentId);
    await service.rpc("wayne_settle_payment", {
      payload: { payment_id: paymentId.data, status: result.status === "voided" ? "voided" : result.status, provider_status: result.providerStatus },
    });
  } catch (cause) {
    logger.error("void.provider_failed", cause, { order_id: orderId.data });
    redirect(`${path}?error=${encodeURIComponent(cause instanceof PaymentProviderError ? cause.message : "The payment could not be voided.")}`);
  }
  revalidatePath(path);
  redirect(`${path}?saved=voided`);
}
