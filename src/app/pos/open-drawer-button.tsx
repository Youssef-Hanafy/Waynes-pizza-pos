"use client";

import { useState } from "react";

/**
 * "Open drawer" with no sale (owner, 2026-10-11): making change, a forgotten
 * bill.  Queues a drawer kick that the print station (the POS Android app at
 * the counter) sends to the receipt printer's drawer port; it is audited.
 */
export function OpenDrawerButton() {
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function open() {
    if (state === "busy") return;
    setState("busy"); setMessage("");
    try {
      const response = await fetch("/api/pos/drawer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "no_sale", reason: "no sale" }),
        signal: AbortSignal.timeout(8000),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body ? String(body.error) : "The drawer could not be opened.");
      setState("sent");
    } catch (cause) {
      setState("error");
      setMessage(cause instanceof Error ? cause.message : "The drawer could not be opened.");
    } finally {
      window.setTimeout(() => setState((current) => (current === "busy" ? current : "idle")), 4000);
    }
  }

  return <button
    aria-live="polite"
    className={`min-h-11 rounded-xl px-3 text-sm font-black uppercase tracking-wider transition ${state === "error" ? "bg-wayne-alert-soft text-wayne-alert" : state === "sent" ? "bg-wayne-ok text-white" : "bg-white/10 text-wayne-cream hover:bg-white/20"}`}
    disabled={state === "busy"}
    onClick={() => { void open(); }}
    title={message || "Open the cash drawer without a sale"}
    type="button"
  >{state === "busy" ? "Opening…" : state === "sent" ? "✓ Drawer opening" : state === "error" ? "⚠ Drawer" : "⏏ Open drawer"}</button>;
}
