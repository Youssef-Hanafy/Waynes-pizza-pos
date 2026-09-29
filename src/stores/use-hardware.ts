"use client";

import { useEffect, useState } from "react";
import { hardwareEventBus } from "@/hardware/event-bus";
import { printerConfigFrom } from "@/hardware/printers/provider";
import { createHardwareRuntime } from "@/hardware/runtime";
import type { HardwareSettings } from "@/lib/hardware/schemas";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import { connectHardwareStore, setHardwareRuntime } from "./hardware-store";
import { loadSavedDrafts } from "./order-store";
import { connectPhoneStore, phoneActions } from "./phone-store";

/**
 * Brings the hardware layer up for a screen (the POS, Admin → Hardware):
 * providers → event bus → stores, plus reconnect handling.  Depends on the
 * configuration values rather than the settings object, so a background
 * refresh of the page never restarts the caller ID connection.
 */
export function useHardware(hardware: HardwareSettings, options: { drafts?: boolean } = {}) {
  const [ready, setReady] = useState(false);
  const withDrafts = options.drafts ?? true;
  const {
    caller_id_provider: providerKind, simulator_enabled: simulatorEnabled, caller_line_count: lineCount,
    caller_udp_port: udpPort, caller_bind_address: bindAddress, caller_device_ip: deviceIp, call_expire_minutes: expireMinutes,
  } = hardware;
  // Printer and drawer settings are compared as text so a background refresh
  // that returns the same settings does not restart anything.
  const printerKey = JSON.stringify([hardware.receipt_printer, hardware.kitchen_printers[0] ?? {}, hardware.cash_drawer]);

  useEffect(() => {
    if (withDrafts) loadSavedDrafts();
    phoneActions.configure(lineCount, expireMinutes);
    const [receipt, kitchen, drawer] = JSON.parse(printerKey) as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    const runtime = createHardwareRuntime({
      callerIdProvider: providerKind, simulatorEnabled, lineCount, udpPort, bindAddress, deviceIp,
      receiptPrinter: printerConfigFrom(receipt), kitchenPrinter: printerConfigFrom(kitchen),
      drawerConnection: typeof drawer.connection === "string" ? drawer.connection : "none",
    }, hardwareEventBus, createBrowserSupabaseClient());
    setHardwareRuntime(runtime);
    const offPhone = connectPhoneStore(hardwareEventBus);
    const offHardware = connectHardwareStore(hardwareEventBus);
    let alive = true;
    void runtime.start().then(() => { if (alive) setReady(true); });
    void phoneActions.refresh();

    // Coming back online or to the foreground: resend what never reached the
    // server and pull the board once.  Event driven, not a poll (§20).
    const back = () => { phoneActions.retryUnsynced(); void phoneActions.refresh(); void runtime.refreshStatus(); };
    const visible = () => { if (document.visibilityState === "visible") back(); };
    window.addEventListener("online", back);
    document.addEventListener("visibilitychange", visible);
    // A local clock quiets cards nobody took (§34.6); it reads no server.
    const expiry = window.setInterval(() => phoneActions.expireStale(), 15_000);
    const status = window.setInterval(() => void runtime.refreshStatus(), 30_000);
    return () => {
      alive = false;
      window.removeEventListener("online", back);
      document.removeEventListener("visibilitychange", visible);
      window.clearInterval(expiry);
      window.clearInterval(status);
      offPhone();
      offHardware();
      void runtime.stop();
      setHardwareRuntime(null);
    };
  }, [providerKind, simulatorEnabled, lineCount, udpPort, bindAddress, deviceIp, expireMinutes, withDrafts, printerKey]);

  return ready;
}
