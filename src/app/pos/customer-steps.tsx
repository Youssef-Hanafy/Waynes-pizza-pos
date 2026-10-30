"use client";

import { logDevice } from "@/lib/pos/device-log";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/menu/schemas";
import type { OpenOrder } from "@/lib/orders/status";
import { ticketNumber } from "@/lib/orders/ticket-number";
import { askCustomer, reclaimCustomerScreen, showOnCustomerScreen, thankCustomer, useCustomerScreen } from "@/stores/customer-display-link";
import { startSignStep, startTipStep, type SignStep, type SignView, type TipStep, type TipView } from "@/lib/pos/checkout-steps";

async function readError(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : fallback;
}

export { thankCustomer } from "@/stores/customer-display-link";

/** What the cashier is told when the customer screen can't show the current request (owner, 2026-10-29). */
function ScreenTrouble({ what }: { what: string }) {
  const screen = useCustomerScreen();
  if (!screen.showing) return <div className="mt-3 rounded-xl bg-wayne-warn-soft p-3 text-left font-bold" role="status">
    <p>Another register named “{screen.key}” is using the customer screen, so the customer can&apos;t see the {what}.</p>
    <Button className="mt-2" onClick={reclaimCustomerScreen} size="sm" variant="secondary">Show the {what} on the customer screen again</Button>
  </div>;
  if (!screen.screenOnline) return <p className="mt-3 rounded-xl bg-wayne-warn-soft p-3 text-left font-bold" role="status">The customer screen isn&apos;t connected. The {what} comes back on it as soon as it reconnects — or use the button below.</p>;
  return null;
}

/**
 * Before the card is run: the customer picks a tip on the customer screen
 * (owner, 2026-10-11).  The tip goes on the order, so the reader is sent the
 * new total.  The cashier can skip it.  The step ends once, with the total the
 * server has (owner, 2026-10-29).
 */
export function CustomerTipStep({ order, onDone }: { order: OpenOrder; onDone: (order: OpenOrder) => void }) {
  const [view, setView] = useState<TipView>({ stage: "waiting" });
  const error = view.stage === "failed" ? view.error : "";
  // Every message shown here goes to the device log too, so a "couldn't" on the Elo can be read back (owner, 2026-10-28).
  useEffect(() => { if (error) logDevice("pos.error_shown", error, { screen: "customer_tip", order: order.order_number }); }, [error, order.order_number]);
  const step = useRef<TipStep | null>(null);

  useEffect(() => {
    const started = startTipStep({
      orderTotalCents: order.total_cents,
      ask: () => askCustomer({ phase: "tip", order_number: ticketNumber(order), total_cents: order.total_cents, tip_base_cents: order.total_cents }),
      saveTip: async (tip) => {
        const response = await fetch(`/api/pos/orders/${order.id}/tip`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tip_cents: tip }), signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) throw new Error(await readError(response, "The tip could not be added."));
        return await response.json() as { total_cents: number };
      },
      showPay: (totalCents, tipCents) => showOnCustomerScreen({ phase: "pay", order_number: ticketNumber(order), ...(tipCents ? { tip_cents: tipCents } : {}), total_cents: totalCents, message: "Please pay on the card reader." }),
      onDone: (totalCents) => onDone(totalCents === order.total_cents ? order : { ...order, total_cents: totalCents }),
      onView: setView,
    });
    step.current = started;
    return () => { started.stop(); };
  }, [order, onDone]);

  const saving = view.stage === "saving";
  const note = view.stage === "waiting" ? "Waiting for the customer to choose a tip on the screen…"
    : view.tipCents ? `${saving ? "Adding" : "Couldn't add"} a ${formatCents(view.tipCents)} tip${saving ? "…" : "."}`
    : saving ? "Confirming the total without a tip…" : "Couldn't confirm the total without a tip.";
  return <div className="mt-5 rounded-2xl border-2 border-wayne-green p-5 text-center">
    <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">Customer screen</p>
    <p aria-live="polite" className="mt-2 text-2xl font-black">{note}</p>
    {view.stage === "waiting" ? <ScreenTrouble what="tip choice" /> : null}
    {error ? <p className="mt-3 rounded-xl bg-wayne-alert-soft p-3 font-bold text-wayne-alert" role="alert">{error} Nothing has been charged.</p> : null}
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      {error ? <>
        <Button disabled={saving} onClick={() => step.current?.retry()} size="lg">{view.stage === "failed" && view.tipCents ? `Try the ${formatCents(view.tipCents)} tip again` : "Try again"}</Button>
        <Button disabled={saving} onClick={() => step.current?.chargeWithoutTip()} size="lg" variant="secondary">Charge without the tip</Button>
      </> : <Button disabled={saving} onClick={() => step.current?.skip()} size="lg" variant="secondary">{saving ? "Saving the tip…" : `Skip tip · charge ${formatCents(order.total_cents)}`}</Button>}
    </div>
  </div>;
}

/**
 * After the card is approved: the customer signs on the customer screen; the
 * signature is kept with the order.  A failed save is shown, never thanked
 * past (owner, 2026-10-29); the card is never charged again from here.
 */
export function CustomerSignStep({ order, tipCents, onFinished }: { order: OpenOrder; tipCents: number; onFinished: () => void }) {
  const [view, setView] = useState<SignView>({ stage: "waiting" });
  const error = view.stage === "failed" ? view.error : "";
  useEffect(() => { if (error) logDevice("pos.error_shown", error, { screen: "customer_signature", order: order.order_number }); }, [error, order.order_number]);
  const step = useRef<SignStep | null>(null);

  useEffect(() => {
    const started = startSignStep({
      ask: () => askCustomer({ phase: "sign", order_number: ticketNumber(order), total_cents: order.total_cents, tip_cents: tipCents }),
      saveSignature: async (svg) => {
        const response = await fetch(`/api/pos/orders/${order.id}/signature`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ signature_svg: svg, tip_cents: tipCents }), signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) throw new Error(await readError(response, "The signature could not be saved."));
      },
      thank: () => thankCustomer(),
      onFinished,
      onView: setView,
    });
    step.current = started;
    return () => { started.stop(); };
  }, [order, tipCents, onFinished]);

  const saving = view.stage === "saving";
  const note = saving ? "Saving the signature…" : error ? "The signature wasn't saved." : "Waiting for the customer to sign on the screen…";
  return <div className="mx-auto max-w-xl rounded-2xl border-2 border-wayne-green p-6 text-center">
    <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-ok">Approved · {formatCents(order.total_cents)}</p>
    <p aria-live="polite" className="mt-3 text-2xl font-black">{note}</p>
    {view.stage === "waiting" ? <ScreenTrouble what="signature pad" /> : null}
    {error ? <p className="mt-3 rounded-xl bg-wayne-alert-soft p-3 font-bold text-wayne-alert" role="alert">{error} The card payment is done and won&apos;t be charged again.</p> : null}
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      {error ? <Button disabled={saving} onClick={() => step.current?.retry()} size="lg">Try saving the signature again</Button> : null}
      <Button className={error ? "" : "sm:col-span-2"} disabled={saving} onClick={() => step.current?.skip()} size="lg" variant="secondary">{error ? "Finish without the signature" : "Skip signature"}</Button>
    </div>
  </div>;
}
