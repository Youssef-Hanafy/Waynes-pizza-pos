import { buildKitchenTicket, type PrintDocument, type PrintLayout } from "./document";
import { PrinterUnavailableError, type PrinterAdapter, type PrinterJob, type PrinterReceipt } from "./adapter";
import type { PrintQueueRepository } from "./worker";

/**
 * The print station's side of the durable print queue (Phase 7).  One
 * register — the one switched to "Print station" — claims jobs and prints
 * them on the store's printers:
 *
 *   destination "kitchen", job kitchen_ticket  → TM-U220B, kitchen ticket
 *   destination "receipt", job online_order    → TM-T20III, order slip (+ tip & signature slip)
 *   destination "receipt", job delivery_receipt → TM-T20III, customer receipt (register/phone delivery)
 *   destination "receipt", job receipt_request  → TM-T20III, customer receipt someone asked for
 *
 * Three outcomes, never blurred together:
 *   printed           → job marked printed
 *   printer offline   → nothing was sent; job handed back to wait (release)
 *   anything unknown  → left for a person to inspect (no automatic reprint)
 */

/** Jobs older than this are not printed automatically: a ticket for an order from hours ago would only confuse the kitchen. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

export type StationResult = { ok: true; jobId?: string } | { ok: false; reason: string; notSent?: boolean };

export type StationPrinter = {
  printLayout(layout: PrintLayout): Promise<StationResult>;
  printOnlineOrder(orderId: string, options: { tipSlip: boolean }): Promise<StationResult>;
  printReceipt(orderId: string): Promise<StationResult>;
};

/** A definite "not sent" that should wait for the printer rather than fail the job. */
export class PrinterOfflineError extends PrinterUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "PrinterOfflineError";
  }
}

export function isStale(job: Pick<PrinterJob, "created_at">, now = Date.now()) {
  if (!job.created_at) return false;
  const created = Date.parse(job.created_at);
  return Number.isFinite(created) && now - created > STALE_AFTER_MS;
}

function settle(result: StationResult): PrinterReceipt {
  if (result.ok) return { receiptId: result.jobId };
  // Certain nothing reached the printer: wait for it.  Otherwise the outcome is unknown.
  if (result.notSent) throw new PrinterOfflineError(result.reason);
  throw new Error(result.reason);
}

function guard(job: PrinterJob, now: () => number) {
  if (isStale(job, now())) {
    throw new PrinterUnavailableError("Not printed automatically: it was more than an hour old when the print station picked it up. Reprint it from the order if it's still needed.");
  }
}

export function tipSlipWanted(setting: "always" | "card" | "never", paymentMethod: unknown) {
  return setting === "always" || (setting === "card" && paymentMethod === "card");
}

export function createKitchenStationAdapter(options: {
  printer: StationPrinter;
  routingCategories: readonly string[];
  loadDocument: (orderId: string) => Promise<PrintDocument>;
  now?: () => number;
}): PrinterAdapter {
  const now = options.now ?? Date.now;
  return {
    async print(job) {
      guard(job, now);
      let doc: PrintDocument;
      try {
        doc = await options.loadDocument(job.order_id);
      } catch (error) {
        throw new PrinterOfflineError(error instanceof Error ? error.message : "The order could not be loaded for printing.");
      }
      const ticket = buildKitchenTicket(doc, options.routingCategories);
      // Nothing on this order goes to the kitchen printer (e.g. drinks only): done.
      if (!ticket) return { receiptId: "nothing-for-this-printer" };
      return settle(await options.printer.printLayout(ticket));
    },
  };
}

export function createOnlineOrderStationAdapter(options: {
  printer: StationPrinter;
  tipSlip: "always" | "card" | "never";
  now?: () => number;
}): PrinterAdapter {
  const now = options.now ?? Date.now;
  return {
    async print(job) {
      guard(job, now);
      if (job.job_type === "online_order") {
        return settle(await options.printer.printOnlineOrder(job.order_id, { tipSlip: tipSlipWanted(options.tipSlip, job.payload.payment_method) }));
      }
      if (job.job_type === "delivery_receipt" || job.job_type === "receipt_request") {
        return settle(await options.printer.printReceipt(job.order_id));
      }
      throw new PrinterUnavailableError(`The receipt printer does not print "${job.job_type}" jobs.`);
    },
  };
}

/**
 * Wraps the queue so a printer that isn't answering hands the job back
 * (it prints when the printer returns) instead of failing it.
 */
export function createStationRepository(base: PrintQueueRepository, release: (job: PrinterJob, reason: string) => Promise<void>) {
  let offline: string | null = null;
  const lastOffline = new Set<string>();
  const repository: PrintQueueRepository = {
    claim: (destination, workerId) => base.claim(destination, workerId),
    complete: (job) => base.complete(job),
    async fail(job, error) {
      if (lastOffline.has(job.id)) {
        lastOffline.delete(job.id);
        offline = error.message;
        await release(job, error.message);
        return;
      }
      await base.fail(job, error);
    },
  };
  return {
    repository,
    /** Wrap an adapter so offline errors are recognised by job id. */
    watch(adapter: PrinterAdapter): PrinterAdapter {
      return {
        async print(job, options) {
          try {
            return await adapter.print(job, options);
          } catch (error) {
            if (error instanceof PrinterOfflineError) lastOffline.add(job.id);
            throw error;
          }
        },
      };
    },
    /** The last "printer not answering" message since the previous call, if any. */
    takeOffline() {
      const value = offline;
      offline = null;
      return value;
    },
  };
}
