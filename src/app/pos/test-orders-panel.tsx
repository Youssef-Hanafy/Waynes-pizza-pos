"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** Delete every test order (they never count in sales, this just tidies up). */
export function TestOrdersPanel() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function clear() {
    if (!confirming) { setConfirming(true); setMessage(""); return; }
    setBusy(true); setConfirming(false);
    try {
      const response = await fetch("/api/pos/test-orders", { method: "DELETE", signal: AbortSignal.timeout(15_000) });
      const body = await response.json().catch(() => null) as { removed?: number; error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "The test orders could not be deleted.");
      setMessage(body?.removed ? `Deleted ${body.removed} test order${body.removed === 1 ? "" : "s"}.` : "There were no test orders to delete.");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "The test orders could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  return <section className="rounded-3xl bg-white p-5 shadow-sm">
    <h2 className="text-xl font-black">🧪 Test orders</h2>
    <p className="mt-1 text-sm text-wayne-muted">Tick <strong>Test order</strong> on the New Order card to practise: the ticket prints, the drawer opens, and every payment screen works the same — but card payments are simulated (no card is ever charged). Test orders never count in sales, the drawer total, the calendar or Admin → Orders, and no customer is saved or texted.</p>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button disabled={busy} onClick={() => { void clear(); }} variant={confirming ? "primary" : "secondary"}>{busy ? "Deleting…" : confirming ? "Tap again to delete all test orders" : "Delete all test orders"}</Button>
      {confirming ? <Button onClick={() => setConfirming(false)} variant="ghost">Cancel</Button> : null}
    </div>
    {message ? <p aria-live="polite" className="mt-2 text-sm font-bold">{message}</p> : null}
  </section>;
}
