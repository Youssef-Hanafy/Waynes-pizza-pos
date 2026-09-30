import { logger } from "@/lib/logging/logger";
import { PaymentProviderError } from "@/lib/payments/provider";
import { ensureTerminalLocation, guardStripeTerminal, json } from "@/lib/payments/stripe-terminal";

/** The Stripe location the M2 registers to when the app connects it (created on first use). */
export async function POST(request: Request) {
  const guard = await guardStripeTerminal(request);
  if (!guard.ok) return guard.response;
  try {
    return json({ location_id: await ensureTerminalLocation(guard.account), environment: guard.account.environment });
  } catch (cause) {
    logger.error("stripe_terminal.location_failed", cause);
    return json({ error: cause instanceof PaymentProviderError ? cause.message : "The card reader's store location could not be set up." }, 502);
  }
}
