import { z } from "zod";
import { logger } from "@/lib/logging/logger";
import { PaymentProviderError } from "@/lib/payments/provider";
import { cancelTerminalIntent, guardStripeTerminal, json, readTerminalIntent } from "@/lib/payments/stripe-terminal";
import { findTerminalPayment, settleTerminalPayment } from "@/lib/payments/stripe-terminal-ledger";
import { createServiceSupabaseClient } from "@/lib/supabase/server";

const bodySchema = z.object({ payment_id: z.uuid() });

/** Give up on the card for now (cash instead, customer left…). Money already taken is never cancelled here. */
export async function POST(request: Request) {
  const guard = await guardStripeTerminal(request);
  if (!guard.ok) return guard.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "Invalid request." }, 400);
  const service = createServiceSupabaseClient();
  const payment = await findTerminalPayment(service, parsed.data.payment_id, guard.account.workspaceId);
  if (!payment) return json({ error: "Card reader payment not found." }, 404);
  try {
    let intent = await readTerminalIntent(guard.account, payment.provider_payment_id);
    if (intent.state === "open" || intent.state === "authorized") intent = await cancelTerminalIntent(guard.account, intent.id);
    await settleTerminalPayment(service, payment.id, intent);
    return json({ state: intent.state });
  } catch (cause) {
    logger.error("stripe_terminal.cancel_failed", cause, { payment_id: payment.id });
    return json({ error: cause instanceof PaymentProviderError ? cause.message : "The card payment could not be cancelled." }, 502);
  }
}
