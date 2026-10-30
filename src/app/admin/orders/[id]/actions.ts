"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/access";
import { logger } from "@/lib/logging/logger";
import { orderTransitionSchema, transitionErrorMessage } from "@/lib/orders/status";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { reconcileRefundLegs, type RefundLeg } from "@/lib/payments/refund-operation";
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
  const access = await requirePermission("payments.manage", path);

  const amount = parseAmountInput(String(form.get("amount") ?? ""));
  if (!amount.ok) redirect(`${path}?error=${encodeURIComponent(amount.error)}`);
  const tipInput = String(form.get("tip_amount") ?? "0").trim();
  const tip = /^0(?:\.0{1,2})?$/.test(tipInput) ? { ok: true as const, cents: 0 } : parseAmountInput(tipInput);
  if (!tip.ok) redirect(`${path}?error=${encodeURIComponent(tip.error)}`);
  const parsed = refundRequestSchema.safeParse({
    tip_cents: tip.ok ? tip.cents : 0,
    payment_id: form.get("payment_id"),
    amount_cents: amount.ok ? amount.cents : 0,
    reason: form.get("reason"),
    idempotency_key: String(form.get("idempotency_key") ?? ""),
  });
  if (!parsed.success) redirect(`${path}?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Check the refund details.")}`);

  const supabase = await createServerSupabaseClient();
  const { data: payment, error: paymentError } = await supabase.from("payments").select("provider,order_id").eq("id",parsed.data.payment_id).single();
  if (paymentError || payment?.order_id !== orderId.data) redirect(`${path}?error=Payment%20does%20not%20belong%20to%20this%20order`);
  if (payment.provider === "stripe") {
    const resolved = await resolvePaymentProvider("online", access.workspace_id ? { workspaceId: access.workspace_id, locationId: access.location_id ?? null } : undefined);
    if (!resolved.ok || resolved.value.provider.code !== "stripe") redirect(`${path}?error=Stripe%20is%20not%20available`);
    const begun = await supabase.rpc("wayne_begin_allocated_refund", { payload: { ...parsed.data, order_id: orderId.data } });
    if (begun.error) redirect(`${path}?error=${encodeURIComponent(paymentErrorMessage(begun.error))}`);
    let pending: boolean;
    try {
      const result = await reconcileRefundLegs(createServiceSupabaseClient(), resolved.value.provider, (begun.data as { legs: RefundLeg[] }).legs);
      pending = result.pending;
    } catch (cause) {
      logger.error("refund.reconciliation_pending", cause, { order_id: orderId.data });
      redirect(`${path}?error=${encodeURIComponent(cause instanceof Error ? cause.message : "Resume the existing refund request.")}`);
    }
    revalidatePath(path); revalidatePath("/admin/payments");
    redirect(`${path}?saved=${pending ? "refund_pending" : "refunded"}`);
  }
  if (parsed.data.tip_cents > 0) redirect(`${path}?error=Explicit%20tip%20refunds%20require%20Stripe`);
  const { data, error } = await supabase.rpc("wayne_begin_refund", { payload: parsed.data });
  if (error) redirect(`${path}?error=${encodeURIComponent(paymentErrorMessage(error))}`);
  const begun = data as { refund_id: string; duplicate: boolean; provider_payment_id: string | null };
  if (begun.duplicate) redirect(`${path}?saved=refund_duplicate`);
  if (!begun.provider_payment_id) redirect(`${path}?error=${encodeURIComponent("That payment has no processor reference to refund.")}`);

  const resolved = await resolvePaymentProvider("online", access.workspace_id ? { workspaceId: access.workspace_id, locationId: access.location_id ?? null } : undefined);
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
  const access = await requirePermission("payments.manage", path);
  const paymentId = z.uuid().safeParse(form.get("payment_id"));
  if (!paymentId.success) redirect(`${path}?error=${encodeURIComponent("That payment cannot be voided.")}`);

  const resolved = await resolvePaymentProvider("online", access.workspace_id ? { workspaceId: access.workspace_id, locationId: access.location_id ?? null } : undefined);
  if (!resolved.ok) redirect(`${path}?error=${encodeURIComponent("The payment processor is not available.")}`);
  const staff = await createServerSupabaseClient();
  const prepared = await staff.rpc("wayne_prepare_payment_void", { target_payment_id: paymentId.data, target_order_id: orderId.data });
  if (prepared.error) redirect(`${path}?error=${encodeURIComponent(paymentErrorMessage(prepared.error))}`);
  const bound = prepared.data as { duplicate: boolean; provider: string; provider_payment_id: string };
  if (bound.duplicate) redirect(`${path}?saved=voided`);
  if (bound.provider !== resolved.value.provider.code) redirect(`${path}?error=Payment%20processor%20does%20not%20match`);
  const service = createServiceSupabaseClient();
  try {
    const current = await resolved.value.provider.getPaymentStatus(bound.provider_payment_id);
    const result = current.status === "voided" ? current : await resolved.value.provider.voidPayment(bound.provider_payment_id);
    if (result.status !== "voided" || result.providerPaymentId !== bound.provider_payment_id) throw new Error("The provider has not confirmed this authorization was voided.");
    const saved = await service.rpc("wayne_finish_payment_void", { target_payment_id: paymentId.data, provider_id: bound.provider_payment_id });
    if (saved.error) throw new Error("The canceled authorization needs receipt recovery. Retry this void; do not create a charge.");
  } catch (cause) {
    logger.error("void.provider_failed", cause, { order_id: orderId.data });
    redirect(`${path}?error=${encodeURIComponent(cause instanceof Error ? cause.message : "The payment could not be voided.")}`);
  }
  revalidatePath(path);
  redirect(`${path}?saved=voided`);
}
