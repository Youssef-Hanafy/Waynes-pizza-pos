"use client";

import { useState } from "react";
import { PinPad } from "@/components/ui/pin-pad";

type ClockResult = { ok: true; name: string; clocked_in: boolean; minutes?: number; is_driver?: boolean } | { ok: false; error: string };

/** Anyone on staff clocks in or out by typing their PIN (owner, 2026-10-12). */
export async function clockWithPin(pin: string): Promise<ClockResult> {
  try {
    const response = await fetch("/api/pos/clock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }), signal: AbortSignal.timeout(10_000) });
    const body: unknown = await response.json().catch(() => null);
    if (body && typeof body === "object" && "ok" in body) return body as ClockResult;
    return { ok: false, error: "The PIN could not be checked." };
  } catch {
    return { ok: false, error: "No connection. Try again." };
  }
}

function hours(minutes = 0) {
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function ClockButton({ onClocked, label = "⏱ Clock in/out", className }: { onClocked?: () => void; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function submit(pin: string) {
    setBusy(true); setError("");
    const result = await clockWithPin(pin);
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    setDone(result.clocked_in
      ? `${result.name} is clocked in.${result.is_driver ? " Deliveries can be sent out with him now." : ""}`
      : `${result.name} is clocked out (${hours(result.minutes)}).`);
    onClocked?.();
  }

  function close() { setOpen(false); setError(""); setDone(""); }

  return <>
    <button className={className ?? "min-h-11 rounded-xl bg-white/10 px-3 text-sm font-black text-wayne-cream hover:bg-white/20"} onClick={() => setOpen(true)} type="button">{label}</button>
    {open ? <div aria-modal className="fixed inset-0 z-[80] grid place-items-center bg-black/50 p-4 text-wayne-ink" role="dialog">
      <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
        {done ? <div className="grid gap-4 text-center">
          <p className="text-2xl font-black">✅ {done}</p>
          <button className="min-h-14 rounded-2xl bg-wayne-green text-lg font-black text-white" onClick={close} type="button">Done</button>
        </div> : <PinPad busy={busy} error={error} note="Type your PIN to clock in. Type it again to clock out." onCancel={close} onSubmit={(pin) => void submit(pin)} submitLabel="Clock in / out" title="Clock in or out" />}
      </div>
    </div> : null}
  </>;
}
