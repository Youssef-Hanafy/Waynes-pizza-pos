import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { startPosKeyedCard } from "@/lib/payments/pos-keyed-card";
import { PaymentProviderError } from "@/lib/payments/provider";
import { posCardIntentRequestSchema } from "@/lib/payments/schemas";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

/** Prepares a Stripe PaymentIntent after the POS has calculated the authoritative ticket total. */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = posCardIntentRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the delivery ticket." }, { status: 400 });
  const resolved = await resolvePaymentProvider("online");
  if (!resolved.ok || resolved.value.provider.code !== "stripe") return Response.json({ error: "Stripe keyed card payment is not available." }, { status: 503 });

  try {
    const started = await startPosKeyedCard(parsed.data.order);
    const service = createServiceSupabaseClient();
    let intent;
    if (started.payment.duplicate) {
      const { data: payment } = await service.from("payments").select("provider_payment_id").eq("id", started.payment.id).maybeSingle();
      if (!payment?.provider_payment_id) return Response.json({ error: "This payment is still being prepared. Check the ticket before trying again." }, { status: 409 });
      intent = await resolved.value.provider.getOnlinePaymentIntent(payment.provider_payment_id);
    } else {
      intent = await resolved.value.provider.createOnlinePaymentIntent({
        amountCents: started.order.total_cents, idempotencyKey: parsed.data.order.idempotency_key,
        referenceId: started.order.order_number, note: `Wayne's Pizza delivery ${started.order.order_number}`,
        paymentId: started.payment.id, receiptEmail: parsed.data.order.email || null,
      });
      const { error } = await service.from("payments").update({ provider_payment_id: intent.providerPaymentId, provider_status: intent.providerStatus }).eq("id", started.payment.id);
      if (error) throw new PaymentProviderError("The payment could not be prepared. Please try again.", "DATABASE", true);
    }
    return Response.json({ ...started.order, payment_id: started.payment.id, client_secret: intent.clientSecret, payment_status: intent.status === "captured" ? "captured" : "pending" });
  } catch (cause) {
    const error = cause instanceof PaymentProviderError ? cause : null;
    logger.error("pos_keyed_card.stripe_intent_failed", cause, { code: error?.code });
    return Response.json({ error: error?.message ?? "The keyed card payment could not be prepared." }, { status: error?.retryable ? 502 : 400 });
  }
}
