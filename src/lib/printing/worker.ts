import { PrinterUnavailableError, type PrinterAdapter, type PrinterJob, type PrinterReceipt } from "./adapter";

export interface PrintQueueRepository {
  /** Atomically lease a pending job. Never return a job leased to another worker. */
  claim(destination: string, workerId: string): Promise<PrinterJob | null>;
  /** Must match both job.id and job.lease_token, rejecting an expired/stale lease. */
  complete(job: PrinterJob): Promise<void>;
  /** Persist a definite pre-print failure without removing the job or its order. */
  fail(job: PrinterJob, error: { code: string; message: string }): Promise<void>;
}

export type PrintWorkerResult =
  | { status: "idle" }
  | { status: "printed"; jobId: string; receipt: PrinterReceipt }
  | { status: "failed"; jobId: string; error: string }
  | {
      status: "acknowledgement_pending";
      jobId: string;
      reason: "print_outcome_unknown" | "completion_failed" | "failure_record_failed";
      error: string;
      receipt?: PrinterReceipt;
    };

type PrintWorkerOptions = {
  repository: PrintQueueRepository;
  adapter: PrinterAdapter;
  destination: string;
  workerId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Printer operation failed.";
}

/**
 * Processes at most one durable job. Run only in a trusted printer agent; this
 * abstraction is deliberately not connected to a fake production adapter.
 *
 * The database lease must outlast timeoutMs. A timed-out or interrupted adapter
 * can still finish physically printing. An acknowledgement_pending result needs
 * reconciliation before another physical attempt; do not automatically reprint
 * it. A crash between physical output and database acknowledgement cannot provide
 * exactly-once delivery without printer-side job deduplication. Durable queue
 * delivery alone is at-least-once, so operator retries can produce duplicates.
 */
export async function processNextPrintJob(options: PrintWorkerOptions): Promise<PrintWorkerResult> {
  const { repository, adapter, destination, workerId, signal } = options;
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!destination.trim() || destination.trim().length > 120 || !workerId.trim() || workerId.trim().length > 100) throw new Error("Printer destination or worker ID is invalid.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Printer timeout must be a positive integer.");
  signal?.throwIfAborted();

  const job = await repository.claim(destination, workerId);
  if (!job) return { status: "idle" };

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let receipt: PrinterReceipt;
  try {
    const interrupted = new Promise<never>((_, reject) => {
      const interrupt = (message: string) => {
        const error = new Error(message);
        // Reject before signalling adapters so a synchronous adapter cancellation
        // cannot be mistaken for a definitely safe pre-print failure.
        reject(error);
        controller.abort(error);
      };
      onAbort = () => interrupt("Printer operation was interrupted; physical output is unknown.");
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => interrupt("Printer timed out; physical output is unknown."), timeoutMs);
    });
    receipt = await Promise.race([
      interrupted,
      controller.signal.aborted ? Promise.reject(controller.signal.reason) : adapter.print(job, { signal: controller.signal }),
    ]);
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (controller.signal.aborted || !(error instanceof PrinterUnavailableError)) {
      return { status: "acknowledgement_pending", jobId: job.id, reason: "print_outcome_unknown", error: message };
    }
    try {
      await repository.fail(job, { code: error.code, message });
      return { status: "failed", jobId: job.id, error: message };
    } catch (failureError: unknown) {
      return {
        status: "acknowledgement_pending", jobId: job.id, reason: "failure_record_failed", error: errorMessage(failureError),
      };
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }

  // Keep acknowledgement outside the printing catch: a database error after
  // successful output must never schedule another physical print as a failure.
  try {
    await repository.complete(job);
    return { status: "printed", jobId: job.id, receipt };
  } catch (error: unknown) {
    return {
      status: "acknowledgement_pending", jobId: job.id, reason: "completion_failed", error: errorMessage(error), receipt,
    };
  }
}
