import { describe, expect, it } from "vitest";
import {
  DISCONNECTED_RECONCILIATION_MS,
  LIVE_RECONCILIATION_MS,
  MAX_RETRY_RECONCILIATION_MS,
  nextReconciliationDelay,
} from "./reconciliation";

describe("reconciliation scheduling", () => {
  it("uses a lightweight interval while realtime is live", () => {
    expect(nextReconciliationDelay({ live: true, consecutiveFailures: 0 })).toBe(LIVE_RECONCILIATION_MS);
  });

  it("retries a disconnected or failed refresh sooner, with a bounded backoff", () => {
    expect(nextReconciliationDelay({ live: false, consecutiveFailures: 0 })).toBe(DISCONNECTED_RECONCILIATION_MS);
    expect(nextReconciliationDelay({ live: true, consecutiveFailures: 1 })).toBe(DISCONNECTED_RECONCILIATION_MS);
    expect(nextReconciliationDelay({ live: true, consecutiveFailures: 2 })).toBe(DISCONNECTED_RECONCILIATION_MS * 2);
    expect(nextReconciliationDelay({ live: true, consecutiveFailures: 10 })).toBe(MAX_RETRY_RECONCILIATION_MS);
  });
});
