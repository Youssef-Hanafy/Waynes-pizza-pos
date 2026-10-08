import { z } from "zod";
import { logger } from "@/lib/logging/logger";
import { paymentErrorMessage } from "@/lib/payments/schemas";
import { PaymentProviderError } from "@/lib/payments/provider";
import { cancelTerminalIntent, createTerminalIntent, guardStripeTerminal, json, ledgerStatusFor, readTerminalIntent, recordTerminalFailure } from "@/lib/payments/stripe-terminal";
import { settleTerminalPayment } from "@/lib/payments/stripe-terminal-ledger";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server";

const bodySchema = z.object({ order_id: z.uuid(), idempotency_key: z.string().min(16).max(160) });

/**
 * Open (or reopen) the card payment for an order on the Stripe M2.  Returns the
 * PaymentIntent's client secret, which the POS app hands to the reader.
 *
 * A payment already open on the reader for this order is reused — after a
 * decline, a dropped connection or a closed app — so one order can never hold
 * two card authorisations.
 */
export async function POST(request: Request) {
  const guard = await guardStripeTerminal(request);
  if (!guard.ok) return guard.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid card reader request." }, 400);
  const { account } = guard;
  const service = createServiceSupabaseClient();

  const { data: order } = await service.from("orders")
    .select("id, order_number, total_cents, payment_status, status")
    .eq("id", parsed.data.order_id).eq("workspace_id", account.workspaceId).maybeSingle();
  if (!order) return json({ error: "Order not found." }, 404);
  if (order.payment_status === "paid") return json({ error: "This order is already paid.", state: "captured" }, 409);

  try {
    // 1. Reuse an M2 payment that is still open on this order.
    const { data: open } = await service.from("payments")
      .select("id, provider, provider_payment_id, metadata, amount_cents")
      .eq("order_id", order.id).in("status", ["pending", "authorized"])
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (open) {
      const metadata = (open.metadata ?? {}) as Record<string, unknown>;
      const ours = open.provider === "stripe" && metadata.reader === "stripe_m2" && typeof open.provider_payment_id === "string";
      if (!ours) return json({ error: "Another payment is already open on this order. Finish or cancel it first." }, 409);
      const intent = await readTerminalIntent(account, open.provider_payment_id as string);
      const settled = ledgerStatusFor(intent);
      if (settled) {
        await settleTerminalPayment(service, open.id, intent);
        if (settled === "captured") return json({ payment_id: open.id, state: "captured" });
      } else if (intent.amountCents === order.total_cents && intent.state === "open") {
        return json({ payment_id: open.id, client_secret: intent.clientSecret, amount_cents: order.total_cents, state: "open", reused: true });
      } else if (intent.state === "processing") {
        return json({ error: "The last card is still processing on Stripe. Wait a moment, then try again." }, 409);
      } else {
        // The order total changed since the reader was sent the old amount.
        await settleTerminalPayment(service, open.id, await cancelTerminalIntent(account, intent.id));
      }
    }

    // 2. A new payment on the ledger, then its PaymentIntent on Stripe.
    const userClient = await createServerSupabaseClient();
    const { data: beginData, error: beginError } = await userClient.rpc("wayne_begin_payment", {
      payload: { order_id: order.id, idempotency_key: parsed.data.idempotency_key, entry: "terminal", method: "card" },
    });
    if (beginError || !beginData) {
      logger.warn("stripe_terminal.begin_failed", { order_id: order.id, code: beginError?.code });
      return json({ error: beginError ? paymentErrorMessage(beginError) : "The payment could not be opened." }, beginError?.code === "40001" ? 409 : 400);
    }
    const begun = beginData as { payment_id: string; duplicate: boolean; amount_cents: number; order_number: string };
    if (begun.duplicate) return json({ error: "That payment was already started. Tap Charge again to pick it up." }, 409);

    const intent = await createTerminalIntent(account, {
      amountCents: begun.amount_cents, idempotencyKey: parsed.data.idempotency_key, orderNumber: begun.order_number,
      paymentId: begun.payment_id, description: `Order ${begun.order_number} (card reader)`,
    });
    const { data: current } = await service.from("payments").select("metadata").eq("id", begun.payment_id).maybeSingle();
    const { error: saveError } = await service.from("payments").update({
      provider_payment_id: intent.id, provider_status: intent.providerStatus,
      metadata: { ...((current?.metadata ?? {}) as Record<string, unknown>), reader: "stripe_m2" },
    }).eq("id", begun.payment_id);
    if (saveError) {
      await cancelTerminalIntent(account, intent.id).catch(() => undefined);
      await service.rpc("wayne_settle_payment", { payload: { payment_id: begun.payment_id, status: "failed", failure_reason: "The payment could not be recorded." } });
      return json({ error: "The payment could not be recorded. Nothing was charged; try again." }, 500);
    }
    return json({ payment_id: begun.payment_id, client_secret: intent.clientSecret, amount_cents: begun.amount_cents, state: "open" });
  } catch (cause) {
    logger.error("stripe_terminal.intent_failed", cause, { order_id: order.id });
    await recordTerminalFailure(account, request, "server.intent_failed", cause);
    return json({ error: cause instanceof PaymentProviderError ? cause.message : "The card payment could not be prepared." }, 502);
  }
}
