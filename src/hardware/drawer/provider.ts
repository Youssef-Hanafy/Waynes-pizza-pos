import { HardwareUnavailableError, status, type HardwareStatus } from "../types";

/**
 * The cash drawer (§24, §60).  Expected to be kicked through the receipt
 * printer's drawer port, so the real provider will wrap a PrinterProvider.
 * Counting cash is the register shift (Admin → Cash), not this.
 */
export interface CashDrawerProvider {
  getStatus(): Promise<HardwareStatus>;
  open(): Promise<void>;
}

export class UnconfiguredCashDrawerProvider implements CashDrawerProvider {
  async getStatus() {
    return status("not_configured", "Not configured", "Open the drawer with its key until the receipt printer is connected.");
  }

  async open() {
    throw new HardwareUnavailableError("The cash drawer is not connected. Open it with the key.");
  }
}
