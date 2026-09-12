import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { PaymentProviderError } from "@/lib/payments/provider";
import { paymentErrorMessage, terminalActionSchema } from "@/lib/payments/schemas";
import { getPosTerminals } from "@/lib/payments/queries";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server";

/** Card readers the counter may charge. Empty when reader payment is switched off. */
export async function GET() {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  try {
    return Response.json(await getPosTerminals(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json([], { headers: { "Cache-Control": "no-store" } });
  }
}

/**
 * Front-counter card-present payment. The counter starts a checkout on a paired
 * reader, polls it while the customer taps, and can cancel it. The order itself is
 * already placed and cooking — only its payment state moves here.
 */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });

  const parsed = terminalActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid card reader request." }, { status: 400 });

  const resolved = await resolvePaymentProvider("terminal");
  if (!resolved.ok) return Response.json({ error: resolved.reason }, { status: 503 });

  const userClient = await createServerSupabaseClient();
  const service = createServiceSupabaseClient();
  const { order_id, terminal_id, idempotency_key, action } = parsed.data;

  // The staff session opens the payment so the ledger records who took it; the
  // provider call and the settlement run with the server's own credentials.
  if (action === "start") {
    const { data: beginData, error: beginError } = await userClient.rpc("wayne_begin_payment", {
      payload: { order_id, terminal_id, idempotency_key, entry: "terminal", method: "card" },
    });
    if (beginError || !beginData) {
      logger.warn("terminal.begin_failed", { order_id, code: beginError?.code });
      return Response.json({ error: beginError ? paymentErrorMessage(beginError) : "The payment could not be opened." }, { status: beginError?.code === "40001" ? 409 : 400 });
    }
    const begun = beginData as { payment_id: string; duplicate: boolean; device_id: string | null; order_number: string; amount_cents: number };
    if (begun.duplicate) return Response.json({ payment_id: begun.payment_id, state: "pending", duplicate: true }, { headers: { "Cache-Control": "no-store" } });
    if (!begun.device_id) return Response.json({ error: "That card reader is not registered." }, { status: 400 });

    try {
      const checkout = await resolved.value.provider.createCardPresentPayment({
        amountCents: begun.amount_cents,
        idempotencyKey: idempotency_key,
        deviceId: begun.device_id,
        referenceId: begun.order_number,
        note: `Wayne's Pizza order ${begun.order_number}`,
      });
      // The checkout id is what the counter polls and what the webhook matches on, so
      // it is recorded before the customer has touched the reader.
      await service.from("payments")
        .update({ terminal_checkout_id: checkout.checkoutId, provider_status: checkout.providerStatus })
        .eq("id", begun.payment_id);
      return Response.json({ payment_id: begun.payment_id, checkout_id: checkout.checkoutId, state: "pending" }, { headers: { "Cache-Control": "no-store" } });
    } catch (cause) {
      const providerError = cause instanceof PaymentProviderError ? cause : null;
      logger.error("terminal.start_failed", cause, { order_id });
      if (providerError && !providerError.retryable) {
        await service.rpc("wayne_settle_payment", { payload: { payment_id: begun.payment_id, status: "failed", provider_status: providerError.code, failure_reason: providerError.message } });
      }
      return Response.json({ error: providerError?.message ?? "The card reader could not be reached." }, { status: 502 });
    }
  }

  // status / cancel both need the open payment for this order.
  const { data: payment } = await service.from("payments")
    .select("id, terminal_checkout_id, status")
    .eq("order_id", order_id).in("status", ["pending", "authorized"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!payment?.terminal_checkout_id) return Response.json({ error: "No card reader payment is open on this order." }, { status: 404 });

  try {
    const checkout = action === "cancel"
      ? await resolved.value.provider.cancelCardPresentPayment(payment.terminal_checkout_id)
      : await resolved.value.provider.getCardPresentPayment(payment.terminal_checkout_id);

    if (checkout.status === "pending")
      return Response.json({ payment_id: payment.id, state: "pending", provider_status: checkout.providerStatus }, { headers: { "Cache-Control": "no-store" } });

    await service.rpc("wayne_settle_payment", {
      payload: {
        payment_id: payment.id,
        status: checkout.status,
        provider_payment_id: checkout.providerPaymentId,
        provider_status: checkout.providerStatus,
        terminal_checkout_id: checkout.checkoutId,
        amount_cents: checkout.amountCents,
        failure_reason: checkout.failureReason,
      },
    });
    return Response.json({ payment_id: payment.id, state: checkout.status, provider_status: checkout.providerStatus }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logger.error("terminal.poll_failed", cause, { order_id });
    return Response.json({ error: cause instanceof PaymentProviderError ? cause.message : "The card reader could not be reached." }, { status: 502 });
  }
}
