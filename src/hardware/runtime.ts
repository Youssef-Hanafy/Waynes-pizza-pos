import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallerIdProviderKind } from "@/lib/hardware/schemas";
import { AndroidCallerIdProvider, CloudCallerIdProvider, SimulatedCallerIdProvider, type CallerIdProvider } from "./caller-id";
import { UnconfiguredCashDrawerProvider, type CashDrawerProvider } from "./drawer/provider";
import type { HardwareEventBus } from "./event-bus";
import { ManualExternalTerminalProvider, type PaymentTerminalProvider } from "./payments/provider";
import { UnconfiguredPrinterProvider, type PrinterProvider } from "./printers/provider";
import type { HardwareDevice, HardwareStatus } from "./types";

export type HardwareRuntimeConfig = {
  callerIdProvider: CallerIdProviderKind;
  simulatorEnabled: boolean;
  lineCount: number;
  udpPort: number;
  bindAddress: string;
  deviceIp: string;
};

/**
 * Builds the providers for this register and wires every one of them into the
 * event bus (§4, §5).  This is the only file that decides which implementation
 * is active; the rest of the POS asks the bus and the interfaces.
 *
 *   configured provider ─┐
 *   simulator (if on)  ──┼─► hardware event bus ─► phone store ─► screens
 *   cloud (always)     ──┘
 *
 * The cloud provider always runs, because rings recorded by the store bridge
 * or claimed on another register reach this one that way (§22).
 */
export function createHardwareRuntime(config: HardwareRuntimeConfig, bus: HardwareEventBus, client: SupabaseClient | null) {
  const cloud = new CloudCallerIdProvider(client);
  const simulator = config.simulatorEnabled || config.callerIdProvider === "simulated"
    ? new SimulatedCallerIdProvider({ lineCount: config.lineCount })
    : null;
  const android = config.callerIdProvider === "android_native"
    ? new AndroidCallerIdProvider({ port: config.udpPort, bindAddress: config.bindAddress, deviceIp: config.deviceIp || undefined })
    : null;
  const primary: CallerIdProvider = android ?? (config.callerIdProvider === "cloud" ? cloud : simulator ?? cloud);

  const receiptPrinter: PrinterProvider = new UnconfiguredPrinterProvider("Receipt printer");
  const kitchenPrinter: PrinterProvider = new UnconfiguredPrinterProvider("Kitchen printer");
  const cashDrawer: CashDrawerProvider = new UnconfiguredCashDrawerProvider();
  const paymentTerminal: PaymentTerminalProvider = new ManualExternalTerminalProvider();

  const callerProviders = [...new Set([primary, cloud, simulator].filter((provider): provider is CallerIdProvider => provider !== null))];
  const detach: (() => void)[] = [];

  async function refreshStatus() {
    const entries: [HardwareDevice, Promise<HardwareStatus>][] = [
      ["caller_id", primary.getStatus()],
      ["caller_sync", cloud.getStatus()],
      ["receipt_printer", receiptPrinter.getStatus()],
      ["kitchen_printer", kitchenPrinter.getStatus()],
      ["cash_drawer", cashDrawer.getStatus()],
      ["payment_terminal", paymentTerminal.getStatus()],
    ];
    for (const [device, pending] of entries) {
      try {
        bus.emit({ type: "hardware.status", payload: { device, status: await pending } });
      } catch {
        // A provider that cannot report its status is reported as an error by the store.
      }
    }
  }

  return {
    primary,
    cloud,
    simulator,
    receiptPrinter,
    kitchenPrinter,
    cashDrawer,
    paymentTerminal,
    refreshStatus,
    async start() {
      for (const provider of callerProviders) {
        detach.push(provider.onIncomingCall((event) => bus.emit({ type: "caller.incoming", payload: event })));
      }
      detach.push(cloud.onCallChanged((serverCallId) => bus.emit({ type: "caller.changed", payload: { serverCallId } })));
      await Promise.all(callerProviders.map((provider) => provider.start().catch((error: unknown) => console.error("[hardware] start failed", provider.kind, error))));
      await refreshStatus();
    },
    async stop() {
      for (const off of detach.splice(0)) off();
      await Promise.all(callerProviders.map((provider) => provider.stop().catch(() => undefined)));
    },
  };
}

export type HardwareRuntime = ReturnType<typeof createHardwareRuntime>;
