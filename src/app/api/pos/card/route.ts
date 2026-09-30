import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { startPosKeyedCard } from "@/lib/payments/pos-keyed-card";
import { PaymentProviderError } from "@/lib/payments/provider";
import { posCardCheckoutRequestSchema } from "@/lib/payments/schemas";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

/** Charges a Square-tokenized keyed card for a delivery phone order. */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = posCardCheckoutRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the delivery ticket." }, { status: 400 });
  const resolved = await resolvePaymentProvider("online");
  if (!resolved.ok || resolved.value.provider.code !== "square") return Response.json({ error: "Square keyed card payment is not available." }, { status: 503 });

  try {
    const started = await startPosKeyedCard(parsed.data.order);
    if (started.payment.duplicate && started.payment.status === "captured") return Response.json({ ...started.order, payment_status: "captured" });
    if (started.payment.duplicate) return Response.json({ error: "This card payment is already open. Check the order before trying again." }, { status: 409 });
    const result = await resolved.value.provider.createOnlinePayment({
      amountCents: started.order.total_cents,
      idempotencyKey: parsed.data.order.idempotency_key,
      sourceId: parsed.data.payment.source_id,
      verificationToken: parsed.data.payment.verification_token ?? null,
      referenceId: started.order.order_number,
      note: `Wayne's Pizza delivery ${started.order.order_number}`,
    });
    const service = createServiceSupabaseClient();
    const { error: settleError } = await service.rpc("wayne_settle_payment", { payload: {
      payment_id: started.payment.id, status: result.status === "captured" ? "captured" : result.status === "authorized" ? "authorized" : "failed",
      provider_payment_id: result.providerPaymentId, provider_status: result.providerStatus, amount_cents: result.amountCents,
      card_brand: result.cardBrand, card_last4: result.cardLast4, receipt_url: result.receiptUrl, failure_reason: result.failureReason,
      metadata: { source: "pos_keyed_card" },
    } });
    if (settleError) throw new Error("The card was charged, but the ticket could not be finalized. Check the order before charging again.");
    if (result.status !== "captured") return Response.json({ error: result.failureReason ?? "The card was not charged. Try another card." }, { status: 402 });
    return Response.json({ ...started.order, payment_status: "captured" }, { status: 201 });
  } catch (cause) {
    const providerError = cause instanceof PaymentProviderError ? cause : null;
    logger.error("pos_keyed_card.square_failed", cause, { code: providerError?.code });
    return Response.json({ error: providerError?.message ?? (cause instanceof Error ? cause.message : "The keyed card payment could not be completed.") }, { status: providerError?.retryable ? 502 : 400 });
  }
}
