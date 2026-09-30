import "server-only";

import type { createServiceSupabaseClient } from "@/lib/supabase/server";
import type { TerminalIntentResult } from "./stripe-terminal-mapping";

type Service = ReturnType<typeof createServiceSupabaseClient>;

/** A Stripe M2 payment on an order of this workspace, or null. */
export async function findTerminalPayment(service: Service, paymentId: string, workspaceId: string) {
  const { data } = await service.from("payments")
    .select("id, status, provider, provider_payment_id, metadata, order:orders!inner(id, workspace_id)")
    .eq("id", paymentId).eq("provider", "stripe").eq("orders.workspace_id", workspaceId).maybeSingle();
  const metadata = (data?.metadata ?? {}) as Record<string, unknown>;
  if (!data || metadata.reader !== "stripe_m2" || typeof data.provider_payment_id !== "string") return null;
  return { id: data.id as string, status: data.status as string, provider_payment_id: data.provider_payment_id };
}

/**
 * Record what Stripe says.  Captured marks the order paid (and the database
 * opens the cash drawer, as for every counter payment); canceled voids it.
 * An intent still waiting for a card changes nothing.
 */
export async function settleTerminalPayment(service: Service, paymentId: string, intent: TerminalIntentResult) {
  const status = intent.state === "captured" ? "captured" : intent.state === "authorized" ? "authorized" : intent.state === "canceled" ? "voided" : null;
  if (!status) return;
  const { error } = await service.rpc("wayne_settle_payment", {
    payload: {
      payment_id: paymentId, status, provider_payment_id: intent.id, provider_status: intent.providerStatus,
      amount_cents: intent.amountCents, card_brand: intent.cardBrand, card_last4: intent.cardLast4, receipt_url: intent.receiptUrl,
      failure_reason: status === "voided" ? "Cancelled at the counter." : null, metadata: { source: "stripe_terminal" },
    },
  });
  if (error) throw new Error("Stripe approved the card, but the order could not be marked paid. Check Payments before charging again.");
  // The webhook may have settled first (it doesn't carry the card details): fill them in.
  if (status === "captured" && (intent.cardLast4 || intent.receiptUrl)) {
    await service.from("payments").update({ card_brand: intent.cardBrand, card_last4: intent.cardLast4, receipt_url: intent.receiptUrl }).eq("id", paymentId).is("card_last4", null);
  }
}
