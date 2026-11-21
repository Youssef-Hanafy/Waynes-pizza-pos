"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/menu/schemas";
import { workspaceStorageKey } from "@/lib/tenancy/active-workspace";
import { getClientWorkspaceScope } from "@/lib/tenancy/client-scope";
import { uuid } from "@/lib/uuid";
import { z } from "zod";

const savedSchema = z.object({ key: z.string().min(16), cents: z.number().int().positive() });
type Saved = z.infer<typeof savedSchema>;

/** A saved attempt survives navigation/restarts; checking it never submits again. */
export function OriginalCardTender({ orderId, due, busy, setBusy, onLock, onPaid }: {
  orderId: string; due: number; busy: boolean; setBusy: (busy: boolean) => void;
  onLock: (locked: boolean) => void; onPaid: (cents: number) => void;
}) {
  const [approved, setApproved] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const storageKey = workspaceStorageKey(getClientWorkspaceScope().workspaceId, `original-card-extra.v1.${orderId}`);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const parsed = savedSchema.safeParse(JSON.parse(window.localStorage.getItem(storageKey) ?? "null"));
        if (parsed.success) { setSaved(parsed.data); onLock(true); }
      } catch { /* A new attempt is persisted before any payment request. */ }
      setLoaded(true);
    });
    return () => { active = false; };
  }, [storageKey, onLock]);

  async function charge() {
    if (busy || !loaded || (!approved && !saved)) return;
    const retrying = Boolean(saved);
    const attempt = saved ?? { key: `online-extra-${uuid()}`, cents: due };
    // Storage failure must happen before the server receives any payment request.
    try { window.localStorage.setItem(storageKey, JSON.stringify(attempt)); }
    catch { setMessage("This register could not save the payment request. Try again after checking its storage."); return; }
    setSaved(attempt); setBusy(true); onLock(true); setMessage("");
    try {
      const response = await fetch(`/api/pos/orders/${orderId}/original-card`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotency_key: attempt.key, expected_amount_cents: attempt.cents, customer_approved: true }),
        signal: AbortSignal.timeout(45_000),
      });
      const body = await response.json() as { payment_status?: string; error?: string };
      if (body.payment_status === "captured") {
        window.localStorage.removeItem(storageKey); setSaved(null); onLock(false); setApproved(false); onPaid(attempt.cents); return;
      }
      // Only a definite failure or a refused reservation frees this request.
      if (body.payment_status === "failed" || (!retrying && !body.payment_status && [400, 403, 409, 503].includes(response.status))) {
        window.localStorage.removeItem(storageKey); setSaved(null); onLock(false); setApproved(false);
      }
      setMessage(body.error || "The extra charge is still being checked. Check this same request before collecting payment another way.");
    } catch {
      setMessage("The card network did not answer. Check this same extra charge; do not charge the customer again.");
    } finally { setBusy(false); }
  }

  return <section className="mt-4 rounded-2xl border-2 border-wayne-green bg-wayne-cream p-3">
    <h3 className="text-lg font-black">Charge the original online card</h3>
    <p className="mt-1 text-sm">Only the added balance of {formatCents(due)} is due. The original order and its tip are already paid. This creates a separate charge on the same card.</p>
    {saved && saved.cents !== due ? <p className="mt-2 font-bold" role="alert">A {formatCents(saved.cents)} extra charge is saved. Check it before charging the changed balance.</p> : null}
    {!saved ? <label className="mt-3 flex items-center gap-3 text-sm font-bold"><input className="h-5 w-5" type="checkbox" checked={approved} disabled={busy || !loaded} onChange={(event) => setApproved(event.target.checked)} />Customer approved the added items and {formatCents(due)} charge.</label> : null}
    <Button className="mt-3 w-full" disabled={busy || !loaded || (!saved && !approved)} onClick={() => { void charge(); }} size="lg">{busy ? "Checking card…" : saved ? `Check extra charge · ${formatCents(saved.cents)}` : `Charge original card · ${formatCents(due)}`}</Button>
    {message ? <p className="mt-2 text-sm font-bold" role="status">{message}</p> : null}
  </section>;
}
