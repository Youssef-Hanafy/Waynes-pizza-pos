"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/menu/schemas";
import type { OpenOrder } from "@/lib/orders/status";
import { askCustomer, showOnCustomerScreen } from "@/stores/customer-display-link";

async function readError(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : fallback;
}

/** After a payment: "Thank you" (and the change) on the customer screen, then back to the welcome screen. */
export function thankCustomer(changeCents: number | null = null) {
  showOnCustomerScreen({ phase: "thanks", change_cents: changeCents });
  window.setTimeout(() => showOnCustomerScreen({ phase: "idle" }), 8000);
}

/**
 * Before the card is run: the customer picks a tip on the customer screen
 * (owner, 2026-10-11).  The tip goes on the order, so the reader is sent the
 * new total.  The cashier can skip it.
 */
export function CustomerTipStep({ order, onDone }: { order: OpenOrder; onDone: (order: OpenOrder) => void }) {
  const [note, setNote] = useState("Waiting for the customer to choose a tip on the screen…");
  const [error, setError] = useState("");
  const cancelRef = useRef<() => void>(() => {});
  const done = useRef(false);

  useEffect(() => {
    const request = askCustomer({ phase: "tip", order_number: order.order_number, total_cents: order.total_cents, tip_base_cents: order.total_cents });
    cancelRef.current = request.cancel;
    let alive = true;
    void request.answer.then(async (answer) => {
      if (!alive || done.current) return;
      if (!answer || typeof answer.tip_cents !== "number") { done.current = true; onDone(order); return; }
      const tip = Math.max(0, Math.round(answer.tip_cents));
      if (tip === 0) { done.current = true; onDone(order); return; }
      setNote(`Adding a ${formatCents(tip)} tip…`);
      try {
        const response = await fetch(`/api/pos/orders/${order.id}/tip`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tip_cents: tip }), signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) throw new Error(await readError(response, "The tip could not be added."));
        const body = await response.json() as { total_cents: number };
        showOnCustomerScreen({ phase: "pay", order_number: order.order_number, tip_cents: tip, total_cents: body.total_cents, message: "Please pay on the card reader." });
        done.current = true;
        onDone({ ...order, total_cents: body.total_cents });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The tip could not be added.");
      }
    });
    return () => { alive = false; request.cancel(); };
  }, [order, onDone]);

  return <div className="mt-5 rounded-2xl border-2 border-wayne-green p-5 text-center">
    <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">Customer screen</p>
    <p aria-live="polite" className="mt-2 text-2xl font-black">{note}</p>
    {error ? <p className="mt-3 rounded-xl bg-wayne-alert-soft p-3 font-bold text-wayne-alert">{error}</p> : null}
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      <Button onClick={() => { done.current = true; cancelRef.current(); showOnCustomerScreen({ phase: "pay", order_number: order.order_number, total_cents: order.total_cents, message: "Please pay on the card reader." }); onDone(order); }} size="lg" variant="secondary">Skip tip</Button>
      {error ? <Button onClick={() => { done.current = true; onDone(order); }} size="lg">Charge without the tip</Button> : null}
    </div>
  </div>;
}

/** After the card is approved: the customer signs on the customer screen; the signature is kept with the order. */
export function CustomerSignStep({ order, tipCents, onFinished }: { order: OpenOrder; tipCents: number; onFinished: () => void }) {
  const [note, setNote] = useState("Waiting for the customer to sign on the screen…");
  const cancelRef = useRef<() => void>(() => {});
  const finished = useRef(false);

  useEffect(() => {
    const request = askCustomer({ phase: "sign", order_number: order.order_number, total_cents: order.total_cents, tip_cents: tipCents });
    cancelRef.current = request.cancel;
    let alive = true;
    void request.answer.then(async (answer) => {
      if (!alive || finished.current) return;
      if (answer && typeof answer.signature_svg === "string") {
        setNote("Saving the signature…");
        await fetch(`/api/pos/orders/${order.id}/signature`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signature_svg: answer.signature_svg, tip_cents: tipCents }), signal: AbortSignal.timeout(12_000),
        }).catch(() => undefined);
      }
      finished.current = true;
      thankCustomer();
      onFinished();
    });
    return () => { alive = false; request.cancel(); };
  }, [order, tipCents, onFinished]);

  return <div className="mx-auto max-w-xl rounded-2xl border-2 border-wayne-green p-6 text-center">
    <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-ok">Approved · {formatCents(order.total_cents)}</p>
    <p aria-live="polite" className="mt-3 text-2xl font-black">{note}</p>
    <Button className="mt-4" onClick={() => { finished.current = true; cancelRef.current(); thankCustomer(); onFinished(); }} size="lg" variant="secondary">Skip signature</Button>
  </div>;
}
