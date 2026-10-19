"use client";

import { useState, useTransition } from "react";
import { POS_COLORS } from "@/lib/menu/pos-colors";
import { saveMenuColorAction } from "./actions";

/**
 * POS colour picker (owner, 2026-10-19).  The swatches open inside the card
 * (not as a floating box, which could slide under the sticky Admin bar and hit
 * Lock Admin instead), and a tap saves without leaving the page.
 */
export function ColorPicker({ kind, id, initial, label, hint }: { kind: "category" | "item"; id: string; initial: string | null; label: string; hint: string }) {
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState(initial);
  const [custom, setCustom] = useState(initial ?? "#e53935");
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  function save(next: string) {
    setMessage("Saving…");
    startTransition(async () => {
      const result = await saveMenuColorAction(kind, id, next);
      if (result.ok) { setColor(result.color); setMessage(result.color ? "Saved — the POS shows it within a minute." : "Colour removed."); }
      else setMessage(result.error);
    });
  }

  return (
    <div className="w-full sm:w-auto">
      <button aria-expanded={open} className="flex min-h-10 items-center gap-2 rounded-lg border border-wayne-border bg-white px-3 py-2 text-sm font-bold" onClick={() => setOpen((value) => !value)} type="button">
        <span aria-hidden className="size-5 rounded-full border border-wayne-border-strong" style={{ background: color ?? "repeating-linear-gradient(45deg,#fff,#fff 3px,#ddd 3px,#ddd 6px)" }} />
        🎨 {label}
      </button>
      {open ? (
        <div className="mt-2 w-full max-w-xs rounded-xl border border-wayne-border bg-wayne-cream p-3">
          <p className="text-xs text-wayne-muted">{hint}</p>
          <div className="mt-2 grid grid-cols-5 gap-2">
            {POS_COLORS.map((swatch) => (
              <button aria-label={swatch.name} aria-pressed={color === swatch.hex} className="size-11 rounded-full border-4 disabled:opacity-50" disabled={pending} key={swatch.hex} onClick={() => save(swatch.hex)} style={{ background: swatch.hex, borderColor: color === swatch.hex ? "#1f1a17" : "#ffffff" }} title={swatch.name} type="button" />
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input aria-label="Any colour" className="h-11 w-14 cursor-pointer rounded-lg border border-wayne-border" onChange={(event) => setCustom(event.target.value)} type="color" value={custom} />
            <button className="min-h-11 rounded-lg border border-wayne-border bg-white px-3 text-sm font-bold disabled:opacity-50" disabled={pending} onClick={() => save(custom)} type="button">Use this colour</button>
            {color ? <button className="min-h-11 rounded-lg border border-wayne-border bg-white px-3 text-sm font-bold disabled:opacity-50" disabled={pending} onClick={() => save("")} type="button">None</button> : null}
          </div>
          {message ? <p aria-live="polite" className="mt-2 text-sm font-bold">{message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
