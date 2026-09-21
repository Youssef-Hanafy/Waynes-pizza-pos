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

/**
 * Drawer wired to the receipt printer's kick port (§24, §60): the tablet asks
 * the printer to pulse it.  Only possible with an ESC/POS receipt printer the
 * Android app can reach; otherwise it says so and the key is used.
 */
export class PrinterDrawerProvider implements CashDrawerProvider {
  constructor(private readonly printer: { ip: string; port: number | null; protocol: string; enabled: boolean }) {}

  private ready() {
    return this.printer.enabled && this.printer.protocol === "escpos" && Boolean(this.printer.ip && this.printer.port);
  }

  async getStatus() {
    if (!this.ready()) return status("not_configured", "Not configured", "Set the receipt printer to ESC/POS with its address first. Open the drawer with the key meanwhile.");
    if (typeof window === "undefined" || !window.WaynesNativeHardware?.printer) return status("unavailable", "Needs the app", "The drawer is opened through the receipt printer by the Wayne's POS Android app.");
    return status("connected", "Ready", `Through the receipt printer at ${this.printer.ip}`);
  }

  async open() {
    const bridge = typeof window === "undefined" ? undefined : window.WaynesNativeHardware?.printer;
    if (!this.ready() || !bridge) throw new HardwareUnavailableError("The cash drawer is not connected. Open it with the key.");
    const { encodeDrawerKick } = await import("../printers/escpos");
    const bytes = encodeDrawerKick();
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    await bridge.send({ host: this.printer.ip, port: this.printer.port!, data: btoa(binary), timeoutMs: 5000 });
  }
}
