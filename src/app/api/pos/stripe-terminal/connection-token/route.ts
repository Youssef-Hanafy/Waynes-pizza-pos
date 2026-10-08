import { logger } from "@/lib/logging/logger";
import { PaymentProviderError } from "@/lib/payments/provider";
import { createConnectionToken, guardStripeTerminal, json, recordTerminalFailure } from "@/lib/payments/stripe-terminal";

/** The Stripe Terminal SDK in the POS Android app asks for this whenever it needs to reach Stripe. */
export async function POST(request: Request) {
  const guard = await guardStripeTerminal(request);
  if (!guard.ok) return guard.response;
  try {
    return json({ secret: await createConnectionToken(guard.account) });
  } catch (cause) {
    logger.error("stripe_terminal.token_failed", cause);
    await recordTerminalFailure(guard.account, request, "server.token_failed", cause);
    return json({ error: cause instanceof PaymentProviderError ? cause.message : "The card reader could not be authorised." }, 502);
  }
}
