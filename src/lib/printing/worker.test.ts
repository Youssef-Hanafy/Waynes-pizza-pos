import { afterEach, describe, expect, it, vi } from "vitest";
import { PrinterUnavailableError, type PrinterAdapter, type PrinterJob } from "./adapter";
import { processNextPrintJob, type PrintQueueRepository } from "./worker";

const job: PrinterJob = {
  id: "job-1", order_id: "order-1", destination: "kitchen", job_type: "kitchen_ticket",
  payload: { order_number: 1001, items: [{ name: "Cheese pizza", quantity: 1 }] }, attempts: 1, lease_token: "lease-1",
};

function harness() {
  const repository: PrintQueueRepository = {
    claim: vi.fn().mockResolvedValue(job), complete: vi.fn().mockResolvedValue(undefined), fail: vi.fn().mockResolvedValue(undefined),
  };
  const adapter: PrinterAdapter = { print: vi.fn().mockResolvedValue({ receiptId: "receipt-1" }) };
  return { repository, adapter, destination: "kitchen", workerId: "test-worker" };
}

afterEach(() => vi.useRealTimers());

describe("durable print worker", () => {
  it("does not contact hardware when there is no pending job", async () => {
    const options = harness();
    vi.mocked(options.repository.claim).mockResolvedValue(null);
    expect(await processNextPrintJob(options)).toEqual({ status: "idle" });
    expect(options.repository.claim).toHaveBeenCalledWith("kitchen", "test-worker");
    expect(options.adapter.print).not.toHaveBeenCalled();
  });

  it("passes the stable job and lease through and acknowledges successful output once", async () => {
    const options = harness();
    expect(await processNextPrintJob(options)).toEqual({ status: "printed", jobId: job.id, receipt: { receiptId: "receipt-1" } });
    expect(options.adapter.print).toHaveBeenCalledExactlyOnceWith(job, { signal: expect.any(AbortSignal) });
    expect(options.repository.complete).toHaveBeenCalledExactlyOnceWith(job);
    expect(options.repository.fail).not.toHaveBeenCalled();
  });

  it("records a definite offline failure for durable retry and keeps the order reference", async () => {
    const options = harness();
    vi.mocked(options.adapter.print).mockRejectedValue(new PrinterUnavailableError("Printer offline before submission."));
    expect(await processNextPrintJob(options)).toEqual({ status: "failed", jobId: job.id, error: "Printer offline before submission." });
    expect(options.repository.fail).toHaveBeenCalledExactlyOnceWith(job, { code: "printer_unavailable", message: "Printer offline before submission." });
    expect(options.repository.complete).not.toHaveBeenCalled();
    expect(job.order_id).toBe("order-1");
  });

  it("does not reprint or mark failed if database acknowledgement fails after output", async () => {
    const options = harness();
    vi.mocked(options.repository.complete).mockRejectedValue(new Error("Lease expired."));
    expect(await processNextPrintJob(options)).toEqual({
      status: "acknowledgement_pending", jobId: job.id, reason: "completion_failed", error: "Lease expired.", receipt: { receiptId: "receipt-1" },
    });
    expect(options.adapter.print).toHaveBeenCalledTimes(1);
    expect(options.repository.fail).not.toHaveBeenCalled();
  });

  it("does not assume an unexpected hardware error means nothing was printed", async () => {
    const options = harness();
    vi.mocked(options.adapter.print).mockRejectedValue(new Error("Connection lost awaiting receipt."));
    expect(await processNextPrintJob(options)).toMatchObject({ status: "acknowledgement_pending", reason: "print_outcome_unknown" });
    expect(options.repository.fail).not.toHaveBeenCalled();
    expect(options.repository.complete).not.toHaveBeenCalled();
  });

  it("bounds a stuck adapter, signals cancellation, and preserves ambiguous output for reconciliation", async () => {
    vi.useFakeTimers();
    const options = harness();
    let adapterSignal: AbortSignal | undefined;
    let resolvePrint: ((value: { receiptId: string }) => void) | undefined;
    vi.mocked(options.adapter.print).mockImplementation((_job, { signal }) => {
      adapterSignal = signal;
      return new Promise((resolve) => { resolvePrint = resolve; });
    });
    const pending = processNextPrintJob({ ...options, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ status: "acknowledgement_pending", reason: "print_outcome_unknown" });
    expect(adapterSignal?.aborted).toBe(true);
    resolvePrint?.({ receiptId: "late-receipt" });
    await Promise.resolve();
    expect(options.adapter.print).toHaveBeenCalledTimes(1);
    expect(options.repository.fail).not.toHaveBeenCalled();
    expect(options.repository.complete).not.toHaveBeenCalled();
  });

  it("treats cancellation after submission as an unknown outcome", async () => {
    const options = harness();
    const controller = new AbortController();
    vi.mocked(options.adapter.print).mockImplementation((_job, { signal }) => new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new PrinterUnavailableError("Cancelled.")), { once: true });
      controller.abort();
    }));
    expect(await processNextPrintJob({ ...options, signal: controller.signal })).toMatchObject({
      status: "acknowledgement_pending", reason: "print_outcome_unknown",
    });
    expect(options.repository.fail).not.toHaveBeenCalled();
  });

  it("does not claim when the worker is already stopped", async () => {
    const options = harness();
    const controller = new AbortController();
    controller.abort(new Error("Worker stopped."));
    await expect(processNextPrintJob({ ...options, signal: controller.signal })).rejects.toThrow("Worker stopped.");
    expect(options.repository.claim).not.toHaveBeenCalled();
  });

  it("reports that failure persistence needs reconciliation when the database is unavailable", async () => {
    const options = harness();
    vi.mocked(options.adapter.print).mockRejectedValue(new PrinterUnavailableError("Offline."));
    vi.mocked(options.repository.fail).mockRejectedValue(new Error("Database unavailable."));
    expect(await processNextPrintJob(options)).toMatchObject({ status: "acknowledgement_pending", reason: "failure_record_failed" });
    expect(options.adapter.print).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid settings before leasing a job", async () => {
    const options = harness();
    await expect(processNextPrintJob({ ...options, timeoutMs: 0 })).rejects.toThrow("Printer timeout");
    await expect(processNextPrintJob({ ...options, workerId: " " })).rejects.toThrow("worker ID");
    expect(options.repository.claim).not.toHaveBeenCalled();
  });
});
