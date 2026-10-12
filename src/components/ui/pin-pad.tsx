"use client";

import { useEffect, useState } from "react";

/**
 * Big touch number pad for staff PINs (4–6 numbers).  The digits never show —
 * only dots.  Works with the tablet's keyboard too.
 */
export function PinPad({ title, note, busy = false, error = "", submitLabel = "Enter", onSubmit, onCancel }: {
  title: string;
  note?: string;
  busy?: boolean;
  error?: string;
  submitLabel?: string;
  onSubmit: (pin: string) => void;
  onCancel?: () => void;
}) {
  const [pin, setPin] = useState("");

  function press(key: string) {
    if (busy) return;
    if (key === "clear") { setPin(""); return; }
    if (key === "back") { setPin((current) => current.slice(0, -1)); return; }
    // Submitting clears the dots, so a wrong PIN's next try starts fresh.
    if (key === "enter") { if (pin.length >= 4) { onSubmit(pin); setPin(""); } return; }
    setPin((current) => (current.length >= 6 ? current : current + key));
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (/^[0-9]$/.test(event.key)) press(event.key);
      else if (event.key === "Backspace") press("back");
      else if (event.key === "Enter") press("enter");
      else if (event.key === "Escape" && onCancel) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"];
  return <div className="mx-auto grid w-full max-w-sm gap-4">
    <div className="text-center">
      <h2 className="text-2xl font-black">{title}</h2>
      {note ? <p className="mt-1 text-sm font-bold text-wayne-muted">{note}</p> : null}
    </div>
    <div aria-label={`${pin.length} numbers entered`} className="flex h-10 items-center justify-center gap-3" role="status">
      {Array.from({ length: Math.max(4, pin.length) }, (_, index) => <span aria-hidden className={`h-4 w-4 rounded-full border-2 ${index < pin.length ? "border-wayne-green bg-wayne-green" : "border-wayne-border-strong"}`} key={index} />)}
    </div>
    {error ? <p className="rounded-xl bg-wayne-alert-soft p-3 text-center font-bold text-wayne-alert" role="alert">{error}</p> : null}
    <div className="grid grid-cols-3 gap-2">
      {keys.map((key) => <button className="min-h-16 rounded-2xl border-2 border-wayne-border bg-white text-2xl font-black shadow-sm transition active:scale-[0.97] active:bg-wayne-cream disabled:opacity-50" disabled={busy} key={key} onClick={() => press(key)} type="button">
        {key === "clear" ? <span className="text-base">Clear</span> : key === "back" ? <span aria-label="Delete">⌫</span> : key}
      </button>)}
    </div>
    <div className="grid gap-2">
      <button className="min-h-14 rounded-2xl bg-wayne-green text-lg font-black text-white shadow-sm disabled:opacity-50" disabled={busy || pin.length < 4} onClick={() => press("enter")} type="button">{busy ? "Checking…" : submitLabel}</button>
      {onCancel ? <button className="min-h-12 rounded-2xl border border-wayne-border bg-white font-bold" onClick={onCancel} type="button">Cancel</button> : null}
    </div>
  </div>;
}
