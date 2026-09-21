import { status, type HardwareStatus, type PrintResult } from "../types";

/**
 * Receipt and kitchen printing (§23).  Order screens call these two methods
 * and nothing else.  Kitchen tickets already flow through the server print
 * queue (Phase 5 of the original build); a provider here is for printing from
 * the register itself once the printer models are known.
 *
 * No printer protocol is assumed until the models are confirmed (§2.7, §59).
 */
export interface PrinterProvider {
  getStatus(): Promise<HardwareStatus>;
  printReceipt(orderId: string): Promise<PrintResult>;
  printKitchenTicket(orderId: string): Promise<PrintResult>;
}

export type PrinterConfig = {
  name: string;
  model: string;
  ip: string;
  port: number | null;
  protocol: string;
  enabled: boolean;
  routingCategories?: string[];
};

/** The honest default: says it is not configured, and never claims a print. */
export class UnconfiguredPrinterProvider implements PrinterProvider {
  constructor(private readonly label: string) {}

  async getStatus() {
    return status("not_configured", "Not configured", `${this.label}: model and address not entered yet.`);
  }

  async printReceipt(): Promise<PrintResult> {
    return { ok: false, reason: `${this.label} is not configured.` };
  }

  async printKitchenTicket(): Promise<PrintResult> {
    return { ok: false, reason: `${this.label} is not configured.` };
  }
}
