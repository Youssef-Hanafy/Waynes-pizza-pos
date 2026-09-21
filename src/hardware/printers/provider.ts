import { buildKitchenTicket, buildReceipt, buildTestPage, printDocumentSchema, type PrintDocument, type PrintLayout } from "@/lib/printing/document";
import { status, type HardwareStatus, type PrintResult } from "../types";
import { encodeEscPos } from "./escpos";
import { renderLayoutHtml } from "./render-html";

/**
 * Receipt and kitchen printing (§23).  Order screens call these methods and
 * nothing else; which printer, and how it is spoken to, is decided here from
 * Admin → Hardware.
 *
 * Kitchen tickets keep flowing through the server print queue (Phase 5 of the
 * original build) whatever is set here; a kitchen provider is for printing
 * from the register itself once the printer model is confirmed.
 */
export interface PrinterProvider {
  getStatus(): Promise<HardwareStatus>;
  printReceipt(orderId: string): Promise<PrintResult>;
  printKitchenTicket(orderId: string): Promise<PrintResult>;
  printTest(): Promise<PrintResult>;
}

/** One printer as saved in Admin → Hardware. */
export type PrinterConfig = {
  name: string;
  model: string;
  ip: string;
  port: number | null;
  /** "" = not chosen yet, "browser" = the device's print dialog, "escpos" = ESC/POS over the network. */
  protocol: string;
  enabled: boolean;
  paperWidthMm: number;
  routingCategories: string[];
};

export function nativePrinter() {
  return typeof window === "undefined" ? undefined : window.WaynesNativeHardware?.printer;
}

/** The order as the printer layer needs it (server: wayne_pos_print_document). */
export async function fetchPrintDocument(orderId: string): Promise<PrintDocument> {
  const response = await fetch(`/api/pos/orders/${orderId}/print`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  const parsed = printDocumentSchema.safeParse(await response.json().catch(() => null));
  if (!response.ok || !parsed.success) throw new Error("The order could not be loaded for printing.");
  return parsed.data;
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function failure(error: unknown, fallback: string): PrintResult {
  return { ok: false, reason: error instanceof Error ? error.message : fallback };
}

abstract class LayoutPrinter implements PrinterProvider {
  constructor(protected readonly config: PrinterConfig, protected readonly label: string) {}
  abstract getStatus(): Promise<HardwareStatus>;
  protected abstract output(layout: PrintLayout): Promise<PrintResult>;

  async printReceipt(orderId: string) {
    try { return await this.output(buildReceipt(await fetchPrintDocument(orderId))); } catch (error) { return failure(error, "The receipt could not be printed."); }
  }

  async printKitchenTicket(orderId: string) {
    try {
      const ticket = buildKitchenTicket(await fetchPrintDocument(orderId), this.config.routingCategories);
      if (!ticket) return { ok: false as const, reason: "Nothing on this order is routed to the kitchen printer." };
      return await this.output(ticket);
    } catch (error) { return failure(error, "The kitchen ticket could not be printed."); }
  }

  async printTest() {
    try { return await this.output(buildTestPage(this.config.name || this.label)); } catch (error) { return failure(error, "The test page could not be printed."); }
  }
}

/**
 * The device's own print dialog (§4 BrowserPrintProvider — the basic
 * fallback).  It can only say the dialog opened, never that paper came out.
 */
export class BrowserPrintProvider extends LayoutPrinter {
  async getStatus() {
    return status("connected", "Print dialog", `${this.label} uses this device's print dialog${this.config.enabled ? "" : " until a printer is set up in Admin → Hardware"}.`);
  }

  protected async output(layout: PrintLayout): Promise<PrintResult> {
    if (typeof document === "undefined") return { ok: false, reason: "Printing needs a screen." };
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    frame.srcdoc = renderLayoutHtml(layout, this.config.paperWidthMm);
    document.body.appendChild(frame);
    await new Promise<void>((resolve) => { frame.onload = () => resolve(); window.setTimeout(resolve, 1500); });
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      window.setTimeout(() => frame.remove(), 60_000);
    }
    return { ok: true, jobId: "print-dialog" };
  }
}

/**
 * A network printer spoken to in ESC/POS, reached through the Android app's
 * native layer (§59: the tablet sends straight to the printer on the LAN).
 * Chosen only when the owner sets protocol "escpos" for a confirmed model.
 */
export class NativeEscPosPrinterProvider extends LayoutPrinter {
  async getStatus() {
    if (!this.config.ip || !this.config.port) return status("not_configured", "Not configured", `${this.label}: enter its IP address and port.`);
    if (!nativePrinter()) return status("unavailable", "Needs the app", `${this.label} at ${this.config.ip}:${this.config.port} is reached by the Wayne's POS Android app; a browser cannot open a printer socket.`);
    return status("connected", "Ready", `${this.config.model || "ESC/POS"} at ${this.config.ip}:${this.config.port}`);
  }

  protected async output(layout: PrintLayout): Promise<PrintResult> {
    const bridge = nativePrinter();
    if (!bridge) return { ok: false, reason: `${this.label} can only be reached from the Wayne's POS Android app.` };
    if (!this.config.ip || !this.config.port) return { ok: false, reason: `${this.label} has no IP address or port.` };
    const columns = this.config.paperWidthMm <= 58 ? 32 : 42;
    await bridge.send({ host: this.config.ip, port: this.config.port, data: toBase64(encodeEscPos(layout, { columns })), timeoutMs: 8000 });
    return { ok: true, jobId: `${this.config.ip}:${this.config.port}` };
  }
}

/** Uses the first provider, and the second when the first cannot be reached from this device. */
export class FallbackPrinterProvider implements PrinterProvider {
  constructor(private readonly primary: PrinterProvider, private readonly fallback: PrinterProvider) {}
  private async pick() {
    const state = (await this.primary.getStatus()).state;
    return state === "unavailable" ? this.fallback : this.primary;
  }
  async getStatus() {
    const primary = await this.primary.getStatus();
    if (primary.state !== "unavailable") return primary;
    return { ...primary, state: "connected" as const, label: "Print dialog", detail: `${primary.detail ?? ""} Printing through this device's print dialog meanwhile.`.trim() };
  }
  async printReceipt(orderId: string) { return (await this.pick()).printReceipt(orderId); }
  async printKitchenTicket(orderId: string) { return (await this.pick()).printKitchenTicket(orderId); }
  async printTest() { return (await this.pick()).printTest(); }
}

/** The honest default: says it is not configured, and never claims a print. */
export class UnconfiguredPrinterProvider implements PrinterProvider {
  constructor(private readonly label: string, private readonly detail?: string) {}

  async getStatus() {
    return status("not_configured", "Not configured", this.detail ?? `${this.label}: model and address not entered yet.`);
  }

  async printReceipt(): Promise<PrintResult> {
    return { ok: false, reason: `${this.label} is not configured.` };
  }

  async printKitchenTicket(): Promise<PrintResult> {
    return { ok: false, reason: `${this.label} is not configured.` };
  }

  async printTest(): Promise<PrintResult> {
    return { ok: false, reason: `${this.label} is not configured.` };
  }
}

/**
 * Which provider a printer gets (build sheet §23):
 *   receipt, nothing set up      → print dialog (basic fallback)
 *   protocol "browser"           → print dialog
 *   protocol "escpos" + address  → network printer via the Android app, print dialog outside it (receipt only)
 *   kitchen, nothing set up      → not configured (the server print queue carries kitchen tickets)
 */
export function createPrinterProvider(kind: "receipt" | "kitchen", config: PrinterConfig): PrinterProvider {
  const label = kind === "receipt" ? "Receipt printer" : "Kitchen printer";
  const browser = new BrowserPrintProvider(config, label);
  if (config.enabled && config.protocol === "escpos") {
    const network = new NativeEscPosPrinterProvider(config, label);
    return kind === "receipt" ? new FallbackPrinterProvider(network, browser) : network;
  }
  if (config.protocol === "browser" || (kind === "receipt" && !config.enabled)) return browser;
  return new UnconfiguredPrinterProvider(label, kind === "kitchen" ? "Kitchen tickets print through the kitchen print queue (Admin → Printing) until this printer is set up." : undefined);
}

/** Admin → Hardware stores printers as loose JSON; read it defensively. */
export function printerConfigFrom(raw: Record<string, unknown> | undefined): PrinterConfig {
  const value = raw ?? {};
  const text = (key: string) => (typeof value[key] === "string" ? String(value[key]) : "");
  const port = typeof value.port === "number" && value.port > 0 && value.port <= 65535 ? value.port : null;
  const width = Number(value.paper_width_mm);
  return {
    name: text("name"), model: text("model"), ip: text("ip"), port, protocol: text("protocol"),
    enabled: value.enabled === true, paperWidthMm: width === 58 ? 58 : 80,
    routingCategories: Array.isArray(value.routing_categories) ? value.routing_categories.filter((entry): entry is string => typeof entry === "string") : [],
  };
}
