import { z } from "zod";
import { logger } from "@/lib/logging/logger";
import { PaymentProviderError } from "@/lib/payments/provider";
import { guardStripeTerminal, json, ledgerStatusFor, readTerminalIntent } from "@/lib/payments/stripe-terminal";
import { findTerminalPayment, settleTerminalPayment } from "@/lib/payments/stripe-terminal-ledger";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

const bodySchema = z.object({ payment_id: z.uuid() });

/**
 * After the reader says approved, ask Stripe (never the app) whether the money
 * is in, and settle the order.  A decline leaves the payment open so the next
 * card reuses it.
 */
export async function POST(request: Request) {
  const guard = await guardStripeTerminal(request);
  if (!guard.ok) return guard.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid card reader confirmation." }, 400);
  const service = createServiceSupabaseClient();
  const payment = await findTerminalPayment(service, parsed.data.payment_id, guard.account.workspaceId);
  if (!payment) return json({ error: "Card reader payment not found." }, 404);
  try {
    const intent = await readTerminalIntent(guard.account, payment.provider_payment_id);
    if (ledgerStatusFor(intent)) await settleTerminalPayment(service, payment.id, intent);
    return json({ state: intent.state, card_brand: intent.cardBrand, card_last4: intent.cardLast4, message: intent.state === "open" ? intent.declineMessage : null });
  } catch (cause) {
    logger.error("stripe_terminal.confirm_failed", cause, { payment_id: payment.id });
    return json({ error: cause instanceof PaymentProviderError ? cause.message : "Stripe could not be checked. Do not charge again — check Payments in a moment." }, 502);
  }
}
