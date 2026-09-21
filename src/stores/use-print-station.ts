"use client";

import { useEffect } from "react";
import { printerConfigFrom } from "@/hardware/printers/provider";
import type { HardwareSettings } from "@/lib/hardware/schemas";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { getHardwareRuntime } from "./hardware-store";
import { isPrintStationDevice, printStationStore, startPrintStation, usePrintStation } from "./print-station";

/**
 * Runs the print station on this register when it has been switched on here
 * (More → Print station).  Restarts when the printer settings change.
 */
export function usePrintStationRunner(hardware: HardwareSettings, runtimeReady: boolean) {
  const station = usePrintStation();
  const printerKey = JSON.stringify([hardware.receipt_printer, hardware.kitchen_printers[0] ?? {}]);

  useEffect(() => {
    // The switch lives on this device only; read it once the page is in the browser.
    const timer = window.setTimeout(() => printStationStore.set((state) => ({ ...state, enabled: isPrintStationDevice() })), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!station.enabled || !runtimeReady) return;
    const runtime = getHardwareRuntime();
    const client = createBrowserSupabaseClient();
    if (!runtime || !client) return;
    const [receipt, kitchen] = JSON.parse(printerKey) as [Record<string, unknown>, Record<string, unknown>];
    return startPrintStation({
      client,
      receipt: { config: printerConfigFrom(receipt), provider: runtime.receiptPrinter },
      kitchen: { config: printerConfigFrom(kitchen), provider: runtime.kitchenPrinter },
    });
  }, [station.enabled, runtimeReady, printerKey]);

  return station;
}
