export const LIVE_RECONCILIATION_MS = 60_000;
export const DISCONNECTED_RECONCILIATION_MS = 15_000;
export const MAX_RETRY_RECONCILIATION_MS = 120_000;

/**
 * Realtime carries normal updates. Polling only reconciles after a missed event
 * or while the socket reconnects, and backs off after a failed request.
 */
export function nextReconciliationDelay({ live, consecutiveFailures }: { live: boolean; consecutiveFailures: number }) {
  if (consecutiveFailures > 0) {
    return Math.min(DISCONNECTED_RECONCILIATION_MS * 2 ** Math.min(consecutiveFailures - 1, 3), MAX_RETRY_RECONCILIATION_MS);
  }
  return live ? LIVE_RECONCILIATION_MS : DISCONNECTED_RECONCILIATION_MS;
}
