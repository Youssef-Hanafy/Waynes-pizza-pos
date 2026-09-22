"use client";

import { setPrintStationDevice, usePrintStation, type StationLane } from "@/stores/print-station";

const laneNames: Record<StationLane, string> = { kitchen: "Kitchen printer", receipt: "Receipt printer" };

/** The print station register shouts when a printer stops answering: tickets are waiting. */
export function printStationWarning(station: ReturnType<typeof usePrintStation>) {
  if (!station.enabled) return "";
  for (const name of ["kitchen", "receipt"] as const) {
    const lane = station.lanes[name];
    if (lane.state === "waiting_printer" || lane.state === "error") return `${laneNames[name]}: ${lane.detail}`;
  }
  return "";
}

export function PrintStationPanel({ className = "" }: { className?: string }) {
  const station = usePrintStation();
  return <section className={`rounded-3xl bg-white p-5 shadow-sm ${className}`}>
    <h2 className="text-xl font-black">Print station</h2>
    <p className="mt-1 text-sm text-wayne-muted">Switch this on for <strong>one</strong> device only: the counter tablet running the Wayne&apos;s POS app on ThriveAP. It prints kitchen tickets for every order, receipts for delivery orders, receipts someone asks for, and online order slips, as they come in. It keeps printing while the POS (or this page) is open, so leave that tablet on the POS and signed in during opening hours.</p>
    <label className="mt-3 flex min-h-11 items-center gap-3 text-base font-black"><input checked={station.enabled} className="h-6 w-6" onChange={(event) => setPrintStationDevice(event.target.checked)} type="checkbox" />This device is the print station</label>
    <p className="text-xs text-wayne-muted">This switch is saved on this device only. It&apos;s off on every other register and phone.</p>
    {station.enabled ? <ul className="mt-2 divide-y divide-wayne-border">
      {(["kitchen", "receipt"] as const).map((name) => {
        const lane = station.lanes[name];
        const label = { off: "Off", ready: "✓ Ready", printing: "✓ Printing", waiting_printer: "⚠ Waiting for printer", error: "⚠ Problem" }[lane.state];
        return <li className="flex flex-wrap justify-between gap-3 py-2" key={name}><span className="font-bold">{laneNames[name]}</span><span className="text-right text-sm"><strong>{label}</strong>{lane.printed ? ` · ${lane.printed} printed` : ""}{lane.detail ? <span className="block text-wayne-muted">{lane.detail}</span> : null}</span></li>;
      })}
    </ul> : null}
  </section>;
}


/** A small reminder in the POS header of what this register is doing. */
export function PrintStationBadge() {
  const station = usePrintStation();
  if (!station.enabled) return null;
  const trouble = (["kitchen", "receipt"] as const).some((name) => ["waiting_printer", "error"].includes(station.lanes[name].state));
  const running = station.running;
  return <span className={`rounded-full px-3 py-1 text-xs font-black uppercase tracking-wider ${trouble || !running ? "bg-wayne-warn-soft text-wayne-ink" : "bg-white/15 text-wayne-cream"}`} title="This register is the print station (More → Print station)">{trouble ? "⚠ " : running ? "🖨 " : "⚠ "}Print station{!running ? " · off" : ""}</span>;
}
