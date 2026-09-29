export type PrinterJob = {
  id: string;
  order_id: string;
  destination: string;
  job_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  lease_token: string;
  /** When the job was queued (the print station holds back anything too old). */
  created_at?: string;
};

export type PrinterReceipt = { receiptId?: string };

/**
 * Implemented by the later local/network printer integration. A resolved promise
 * means the adapter has the strongest acknowledgement that device supports; it
 * must never report success simply because hardware is unconfigured.
 *
 * Pass the stable job.id to devices that support deduplication. Aborting a request
 * does not prove the device printed nothing. Only throw PrinterUnavailableError
 * when it is certain that no ticket was submitted or printed.
 */
export interface PrinterAdapter {
  print(job: PrinterJob, options: { signal?: AbortSignal }): Promise<PrinterReceipt>;
}

/** A definite pre-print failure, safe for the durable queue to retry. */
export class PrinterUnavailableError extends Error {
  readonly code = "printer_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "PrinterUnavailableError";
  }
}
