"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { PhoneLineNumber } from "@/hardware/types";
import type { HardwareSettings } from "@/lib/hardware/schemas";
import { formatPhone } from "@/lib/phone/normalize";
import { getHardwareRuntime, useHardwareState } from "@/stores/hardware-store";
import { usePhoneState } from "@/stores/phone-store";
import { useHardware } from "@/stores/use-hardware";
import { usePrintStationRunner } from "@/stores/use-print-station";
import { PrintStationPanel } from "@/components/pos/print-station-panel";

const names: Record<string, string> = {
  caller_id: "Caller ID", caller_sync: "Live updates", receipt_printer: "Receipt printer",
  kitchen_printer: "Kitchen printer", cash_drawer: "Cash drawer", payment_terminal: "Payment terminal",
};

/**
 * Live status and the Test Line buttons (§28, §64).  The test buttons use the
 * simulated provider and the same event bus as the POS, and the ring is
 * recorded, so every open register shows it too.
 */
export function HardwareLive({ settings }: { settings: HardwareSettings }) {
  const ready = useHardware(settings, { drafts: false });
  // If this device is the print station, keep printing while this page is open too.
  usePrintStationRunner(settings, ready);
  const { statuses, online } = useHardwareState();
  const phone = usePhoneState();
  const last = phone.recent[0];

  const [printMessage, setPrintMessage] = useState("");

  async function testPrint(kind: "receipt" | "kitchen" | "drawer") {
    const runtime = getHardwareRuntime();
    if (!runtime) return;
    setPrintMessage("Working…");
    try {
      if (kind === "drawer") { await runtime.cashDrawer.open(); setPrintMessage("Drawer pulse sent."); return; }
      const result = await (kind === "receipt" ? runtime.receiptPrinter : runtime.kitchenPrinter).printTest();
      setPrintMessage(result.ok ? (result.jobId === "print-dialog" ? "Test page sent to this device's print dialog." : `Test page sent to ${result.jobId ?? "the printer"}.`) : result.reason);
    } catch (error) {
      setPrintMessage(error instanceof Error ? error.message : "That did not work.");
    }
  }

  function test(line: PhoneLineNumber) {
    const presets = { 1: { phoneNumber: "5085551111", callerName: "John Test" }, 2: { phoneNumber: "7745552222", callerName: "Jane Test" } } as Record<number, { phoneNumber: string; callerName: string }>;
    getHardwareRuntime()?.simulator?.simulate({ line, ...(presets[line] ?? { phoneNumber: `508555${String(1000 + line).slice(-4)}`, callerName: `Line ${line} Test` }) });
  }

  return <section className="mt-6 grid gap-4 rounded-2xl border border-wayne-border bg-white p-6 lg:grid-cols-[1fr_1fr]">
    <div>
      <h2 className="text-xl font-black">Status</h2>
      <ul className="mt-3 divide-y divide-wayne-border text-sm">
        <li className="flex justify-between gap-3 py-2"><span className="font-bold">Internet</span><span>{online ? "✓ Online" : "⚠ Offline"}</span></li>
        {Object.entries(names).map(([device, name]) => {
          const status = statuses[device as keyof typeof statuses];
          return <li className="flex flex-wrap justify-between gap-3 py-2" key={device}><span className="font-bold">{name}</span><span className="text-right">{status ? <><strong className="uppercase">{status.label}</strong>{status.detail ? <span className="block text-wayne-muted">{status.detail}</span> : null}</> : ready ? "—" : "Starting…"}</span></li>;
        })}
      </ul>
    </div>
    <div className="lg:col-span-2 border-t border-wayne-border pt-4">
      <h2 className="text-xl font-black">Printer test</h2>
      <p className="mt-1 text-sm text-wayne-muted">Prints a test page through the same printer layer receipts use. Save settings first; the page uses the saved ones.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={!ready} onClick={() => void testPrint("receipt")} variant="secondary">Test receipt printer</Button>
        <Button disabled={!ready} onClick={() => void testPrint("kitchen")} variant="secondary">Test kitchen printer</Button>
        <Button disabled={!ready} onClick={() => void testPrint("drawer")} variant="secondary">Open cash drawer</Button>
      </div>
      {printMessage ? <p aria-live="polite" className="mt-2 text-sm font-bold">{printMessage}</p> : null}
    </div>
    <div className="lg:row-start-1 lg:col-start-2">
      <h2 className="text-xl font-black">Caller ID test</h2>
      <p className="mt-1 text-sm text-wayne-muted">Provider: <strong>{settings.caller_id_provider.replace("_", " ")}</strong> · {settings.caller_line_count} lines · UDP {settings.caller_udp_port}</p>
      {settings.simulator_enabled ? <div className="mt-3 flex flex-wrap gap-2">{Array.from({ length: Math.min(settings.caller_line_count, 8) }, (_, index) => (index + 1) as PhoneLineNumber).map((line) => <Button disabled={!ready} key={line} onClick={() => test(line)} variant="secondary">Test Line {line}</Button>)}</div> : <p className="mt-3 text-sm font-bold">Test calls are switched off below.</p>}
      <div className="mt-4 rounded-xl bg-wayne-cream p-3 text-sm">
        <p className="font-bold">Last call</p>
        {last ? <p>Line {last.line_number} · {last.customer_name || formatPhone(last.caller_number ?? last.caller_number_raw)} · {new Date(last.started_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}{last.simulated ? " · test" : ""} · {last.status.replace("_", " ")}</p> : <p className="text-wayne-muted">No calls in the last 12 hours.</p>}
      </div>
      {phone.recent.length > 1 ? <details className="mt-3 text-sm"><summary className="min-h-11 cursor-pointer content-center font-bold">View recent events</summary><ul className="mt-2 grid gap-1">{phone.recent.slice(0, 15).map((call) => <li key={call.id}>{new Date(call.started_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} · Line {call.line_number} · {formatPhone(call.caller_number ?? call.caller_number_raw)} · {call.order_number ? `order ${call.order_number}` : call.status.replace("_", " ")}{call.simulated ? " · test" : ""}</li>)}</ul></details> : null}
    </div>
    <PrintStationPanel className="border border-wayne-border shadow-none lg:col-span-2" />
  </section>;
}
