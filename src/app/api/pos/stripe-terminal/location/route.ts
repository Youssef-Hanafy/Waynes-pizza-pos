import { logger } from "@/lib/logging/logger";
import { PaymentProviderError } from "@/lib/payments/provider";
import { ensureOfflineMode, ensureTerminalLocation, guardStripeTerminal, json, recordTerminalFailure } from "@/lib/payments/stripe-terminal";

/** The Stripe location the M2 registers to when the app connects it (created on first use). */
export async function POST(request: Request) {
  const guard = await guardStripeTerminal(request);
  if (!guard.ok) return guard.response;
  try {
    const locationId = await ensureTerminalLocation(guard.account);
    // Offline card payments (owner, 2026-10-24).  A refusal here is logged, never a reason not to connect.
    let offline = false;
    try {
      offline = await ensureOfflineMode(guard.account, locationId);
    } catch (cause) {
      logger.error("stripe_terminal.offline_mode_failed", cause);
      await recordTerminalFailure(guard.account, request, "server.offline_mode_failed", cause);
    }
    return json({ location_id: locationId, environment: guard.account.environment, offline_mode: offline });
  } catch (cause) {
    logger.error("stripe_terminal.location_failed", cause);
    await recordTerminalFailure(guard.account, request, "server.location_failed", cause);
    return json({ error: cause instanceof PaymentProviderError ? cause.message : "The card reader's store location could not be set up." }, 502);
  }
}
