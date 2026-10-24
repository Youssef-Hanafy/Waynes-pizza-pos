import { z } from "zod";
import { logger } from "@/lib/logging/logger";
import { paymentErrorMessage } from "@/lib/payments/schemas";
import { PaymentProviderError } from "@/lib/payments/provider";
import { guardStripeTerminal, json, readTerminalIntent } from "@/lib/payments/stripe-terminal";
import { settleTerminalPayment } from "@/lib/payments/stripe-terminal-ledger";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  order_id: z.uuid(),
  /** The PaymentIntent Stripe created when the reader forwarded the stored card. */
  intent_id: z.string().regex(/^pi_[A-Za-z0-9_]+$/).max(255),
  /** The reader's own id for the stored payment: one ledger payment per stored card, however often this is sent. */
  offline_id: z.string().min(4).max(120),
});

/**
 * A card taken on the Stripe M2 while the register was offline (owner,
 * 2026-10-24).  The reader stored it and forwarded it to Stripe when the
 * connection came back; its order has been sent since.  This records it on
 * that order, the same way a card taken online is recorded — Stripe is read
 * here on the server, never trusted from the tablet, and the intent must
 * carry this order's ticket key (set by the app when the card was taken).
 */
export async function POST(request: Request) {
  const guard = await guardStripeTerminal(request);
  if (!guard.ok) return guard.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid offline card request." }, 400);
  const { account } = guard;
  const service = createServiceSupabaseClient();

  const { data: order } = await service.from("orders")
    .select("id, order_number, idempotency_key, total_cents, payment_status")
    .eq("id", parsed.data.order_id).eq("workspace_id", account.workspaceId).maybeSingle();
  if (!order) return json({ error: "Order not found." }, 404);

  try {
    const intent = await readTerminalIntent(account, parsed.data.intent_id);
    const raw = await readIntentMetadata(account.secretKey, parsed.data.intent_id);
    if (raw.wayne_order_key !== order.idempotency_key) return json({ error: "That card was taken for a different order." }, 409);
    if (intent.state === "open" || intent.state === "processing") {
      // Declined when Stripe saw it, or still being processed: nothing is recorded; the order stays unpaid.
      return json({ state: intent.state, message: intent.declineMessage ?? "The card was not approved when it reached Stripe." });
    }
    if (intent.state === "canceled") return json({ state: "canceled", message: "Stripe cancelled the stored card." });

    const idempotencyKey = `offline-card-${parsed.data.offline_id}`.slice(0, 160);
    const { data: existing } = await service.from("payments").select("id").eq("idempotency_key", idempotencyKey).maybeSingle();
    let paymentId = existing?.id as string | undefined;
    if (!paymentId) {
      const userClient = await createServerSupabaseClient();
      const { data: begun, error } = await userClient.rpc("wayne_begin_payment", {
        payload: { order_id: order.id, idempotency_key: idempotencyKey, entry: "terminal", method: "card" },
      });
      if (error || !begun) return json({ error: error ? paymentErrorMessage(error) : "The payment could not be recorded." }, error?.code === "40001" ? 409 : 400);
      paymentId = (begun as { payment_id: string }).payment_id;
      const { data: current } = await service.from("payments").select("metadata").eq("id", paymentId).maybeSingle();
      await service.from("payments").update({
        provider_payment_id: intent.id, provider_status: intent.providerStatus,
        metadata: { ...((current?.metadata ?? {}) as Record<string, unknown>), reader: "stripe_m2", offline: true, offline_id: parsed.data.offline_id },
      }).eq("id", paymentId);
    }
    await settleTerminalPayment(service, paymentId, intent);
    return json({ state: intent.state, payment_id: paymentId, card_brand: intent.cardBrand, card_last4: intent.cardLast4 });
  } catch (cause) {
    logger.error("stripe_terminal.offline_settle_failed", cause, { order_id: order.id });
    return json({ error: cause instanceof PaymentProviderError ? cause.message : "The offline card could not be recorded yet." }, 502);
  }
}

/** The intent's metadata exactly as Stripe holds it. */
async function readIntentMetadata(secretKey: string, intentId: string): Promise<Record<string, string>> {
  const response = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(intentId)}`, {
    headers: { Authorization: `Bearer ${secretKey}` }, cache: "no-store", signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new PaymentProviderError("The stored card could not be read from Stripe.", "STRIPE_ERROR", true);
  const body = await response.json().catch(() => null) as { metadata?: Record<string, string> } | null;
  return body?.metadata ?? {};
}
