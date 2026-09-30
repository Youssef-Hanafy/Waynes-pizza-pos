import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { PaymentProviderError } from "@/lib/payments/provider";
import { posKeyedCardIntentSchema } from "@/lib/payments/schemas";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server";

/** Opens a Stripe-hosted card field for an order already on the POS (the card is keyed in by staff, usually over the phone). */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access") || !access?.workspace_id) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = posKeyedCardIntentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid delivery order." }, { status: 400 });

  const resolved = await resolvePaymentProvider("online", { workspaceId: access.workspace_id, locationId: access.location_id ?? null });
  if (!resolved.ok || resolved.value.provider.code !== "stripe") return Response.json({ error: "Stripe keyed card payment is not available." }, { status: 503 });

  const service = createServiceSupabaseClient();
  const { data: order } = await service.from("orders")
    .select("id, source, fulfillment_type")
    .eq("id", parsed.data.order_id).eq("workspace_id", access.workspace_id).maybeSingle();
  if (!order) return Response.json({ error: "Order not found." }, { status: 404 });

  const userClient = await createServerSupabaseClient();
  const { data: beginData, error: beginError } = await userClient.rpc("wayne_begin_payment", {
    payload: { order_id: parsed.data.order_id, idempotency_key: parsed.data.idempotency_key, entry: "pos_keyed_card", method: "card" },
  });
  if (beginError || !beginData) return Response.json({ error: beginError?.code === "40001" ? "A payment is already in progress for this order." : "The card payment could not be opened." }, { status: beginError?.code === "40001" ? 409 : 400 });
  const begun = beginData as { payment_id: string; duplicate: boolean; amount_cents: number; order_number: string };

  try {
    let intent;
    if (begun.duplicate) {
      const { data: payment } = await service.from("payments").select("provider_payment_id").eq("id", begun.payment_id).maybeSingle();
      if (!payment?.provider_payment_id) return Response.json({ error: "This payment is still being prepared. Check the ticket before trying again." }, { status: 409 });
      intent = await resolved.value.provider.getOnlinePaymentIntent(payment.provider_payment_id);
    } else {
      intent = await resolved.value.provider.createOnlinePaymentIntent({
        amountCents: begun.amount_cents, idempotencyKey: parsed.data.idempotency_key, referenceId: begun.order_number,
        note: `${access.workspace_name ?? "Store"} order ${begun.order_number} (keyed card)`, paymentId: begun.payment_id, receiptEmail: null,
      });
      const { error } = await service.from("payments").update({ provider_payment_id: intent.providerPaymentId, provider_status: intent.providerStatus }).eq("id", begun.payment_id);
      if (error) throw new PaymentProviderError("The payment could not be prepared. Please try again.", "DATABASE", true);
    }
    return Response.json({ payment_id: begun.payment_id, client_secret: intent.clientSecret, payment_status: intent.status === "captured" ? "captured" : "pending" }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    const error = cause instanceof PaymentProviderError ? cause : null;
    logger.error("pos.keyed_card_intent_failed", cause, { code: error?.code, order_id: parsed.data.order_id });
    return Response.json({ error: error?.message ?? "The keyed card payment could not be prepared." }, { status: error?.retryable ? 502 : 400 });
  }
}
