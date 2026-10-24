"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCents } from "@/lib/menu/schemas";
import type { PosDraft } from "@/lib/orders/drafts";
import { changeDueCents, quickCashAmounts } from "@/lib/pos/tender";
import { getClientWorkspaceScope } from "@/lib/tenancy/client-scope";
import { uuid } from "@/lib/uuid";
import { cancelOfflineOrder, finishOfflineOrder } from "@/stores/offline-orders";
import { collectOfflineWithStripeReader, stripeOfflineAvailable, useStripeReader } from "@/stores/stripe-reader";

type Mode = "choose" | "cash" | "card";

/**
 * Take payment with NO connection (owner, 2026-10-24).  Shown instead of the
 * normal payment screen when the order could not reach the server: the order
 * is kept on this register as "O1", "O2" … and sent, with its payment, as
 * soon as the connection is back.  Cash, the Stripe M2 (the reader stores the
 * card) and Pay later / Cash at the door all work; keying in a card needs the
 * internet, so it isn't offered here.
 */
export function OfflinePayment({ draft, stripeReader, onDone }: { draft: PosDraft; stripeReader: boolean; onDone: (message: string) => void }) {
  const offline = draft.offline!;
  const due = offline.totalCents;
  const delivery = draft.fulfillment === "delivery" && draft.customerMode !== "walk_in";
  const [mode, setMode] = useState<Mode>("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [digits, setDigits] = useState("");
  const reader = useStripeReader();
  const tendered = digits ? Number.parseInt(digits, 10) : 0;
  const change = changeDueCents(due, tendered);
  // In the store only: an offline card is charged on the spot (a delivery's card waits for its signed slip, which needs the connection).
  const cardOk = stripeReader && !delivery && stripeOfflineAvailable();
  const at = () => new Date().toISOString();

  function press(key: string) {
    setError("");
    if (key === "clear") { setDigits(""); return; }
    if (key === "back") { setDigits((value) => value.slice(0, -1)); return; }
    setDigits((value) => (value + key).replace(/^0+/, "").slice(0, 7));
  }

  async function finish(message: string, payment: Parameters<typeof finishOfflineOrder>[1]) {
    setBusy(true);
    const printed = await finishOfflineOrder(draft.id, payment);
    setBusy(false);
    onDone(`${message}${printed.printed ? "" : ` · ⚠ ${printed.message}`}`);
  }

  async function recordCash() {
    if (change === null) { setError(`Still owed ${formatCents(due - tendered)}.`); return; }
    await finish(`${offline.localNumber} paid cash (offline) · CHANGE DUE ${formatCents(change)}`, { kind: "cash", amountCents: due, tenderedCents: tendered, changeCents: change, at: at() });
  }

  async function takeCard() {
    setBusy(true); setError("");
    const offlineKey = uuid();
    const result = await collectOfflineWithStripeReader({
      amountCents: due, offlineKey, orderKey: draft.idempotencyKey, workspaceId: getClientWorkspaceScope().workspaceId ?? "",
      description: `Order ${offline.localNumber} (taken offline)`,
    });
    setBusy(false);
    if (!result.ok) { setError(result.code === "CANCELED" ? "Cancelled on the reader." : result.message); return; }
    await finish(`${offline.localNumber} paid ${formatCents(due)} on card${result.stored ? " (stored — sent to Stripe when the connection is back)" : ""}`, {
      kind: "card", amountCents: due, offlineKey: result.offlineKey, intentId: result.intentId, brand: result.brand, last4: result.last4, at: at(),
    });
  }

  const option = (value: Mode, icon: string, title: string, note: string, disabled = false) => (
    <button aria-pressed={mode === value} className={`flex min-h-20 flex-col items-center justify-center rounded-2xl border-2 p-2 text-center transition disabled:opacity-40 ${mode === value ? "border-wayne-green bg-wayne-green text-white" : "border-wayne-border bg-wayne-cream hover:border-wayne-green"}`} disabled={disabled || busy} onClick={() => { setMode(value); setError(""); if (value === "card") void takeCard(); }} type="button">
      <span aria-hidden className="text-2xl leading-none">{icon}</span>
      <strong className="mt-1 text-lg font-black leading-tight">{title}</strong>
      <span className="text-xs font-bold text-wayne-muted">{note}</span>
    </button>
  );

  return <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-wayne-cream-deep p-2">
    <section aria-label="Take payment offline" className="w-full rounded-3xl border border-wayne-border bg-white px-4 py-3 shadow-xl">
      <div className="mb-2 rounded-2xl bg-wayne-warn-soft px-3 py-2">
        <p className="font-black">⚠ No connection — order {offline.localNumber} is saved on this register.</p>
        <p className="text-sm font-bold">Take payment as usual. The kitchen ticket prints here, and the order and its payment go to the server by themselves when the connection is back.</p>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">Order {offline.localNumber} · {`${draft.firstName} ${draft.lastName}`.trim() || "Walk-in"}</p><p className="mt-1 text-sm capitalize text-wayne-muted">{delivery ? "delivery" : "pickup"} · {draft.source === "phone" ? "phone" : "in store"}</p></div>
        <div className="text-right"><p className="text-sm font-bold">Amount due</p><p className="text-5xl font-black tabular-nums">{formatCents(due)}</p></div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        {option("cash", "💵", "Cash", "Change shown")}
        {option("card", "💳", "Card reader", cardOk ? "Stored, sent later" : delivery ? "Not for deliveries offline" : stripeReader ? "Reader not connected" : "Not set up", !cardOk)}
        <button className="flex min-h-20 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-wayne-border-strong bg-white p-2 text-center transition hover:border-wayne-green disabled:opacity-40" disabled={busy} onClick={() => { void finish(`${offline.localNumber} saved offline · ${delivery ? "cash at the door" : "pay later"}`, { kind: "later", at: at() }); }} type="button"><span aria-hidden className="text-2xl leading-none">{delivery ? "🚗" : "⏱"}</span><strong className="mt-1 text-lg font-black leading-tight">{delivery ? "Cash at the door" : "Pay later"}</strong><span className="text-xs font-bold text-wayne-muted">Paid in Payments later</span></button>
        <button className="flex min-h-20 flex-col items-center justify-center rounded-2xl border-2 border-wayne-border bg-white p-2 text-center disabled:opacity-40" disabled={busy} onClick={() => { cancelOfflineOrder(draft.id); onDone(""); }} type="button"><span aria-hidden className="text-2xl leading-none">‹</span><strong className="mt-1 text-lg font-black leading-tight">Back to ticket</strong><span className="text-xs font-bold text-wayne-muted">Nothing is saved yet</span></button>
      </div>
      {error ? <p className="mt-2 rounded-xl bg-wayne-alert-soft p-2 font-bold text-wayne-alert" role="alert">{error}</p> : null}
      {mode === "card" && busy ? <p aria-live="polite" className="mt-3 rounded-2xl border-2 border-wayne-green p-4 text-2xl font-black">{reader.prompt || "Tap, insert or swipe the card"}</p> : null}
      {mode === "card" && !busy && error && cardOk ? <Button className="mt-2 w-full" onClick={() => void takeCard()} size="lg">Try the card again</Button> : null}
      {mode === "cash" ? <div className="mt-2 grid gap-3 md:grid-cols-[1fr_22rem] lg:grid-cols-[1fr_26rem]">
        <div className="grid content-start gap-2">
          <div className="rounded-2xl border-2 border-wayne-border px-4 py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3"><p className="text-sm font-bold">Cash received</p><p aria-live="polite" className="text-4xl font-black tabular-nums">{formatCents(tendered)}</p></div>
            <p aria-live="polite" className={`mt-1 text-3xl font-black ${change === null ? "text-wayne-red" : "text-wayne-ok"}`}>{change === null ? (tendered ? `Still owed ${formatCents(due - tendered)}` : "Enter the cash handed over") : `Change ${formatCents(change)}`}</p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {quickCashAmounts(due).map((amount) => <Button className="min-h-14 text-xl" key={amount} onClick={() => { setError(""); setDigits(String(amount)); }} variant="secondary">{amount === due ? "Exact" : formatCents(amount)}</Button>)}
          </div>
        </div>
        <div className="grid content-start gap-1.5">
          <div className="grid grid-cols-3 gap-1.5">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "back"].map((key) => <button aria-label={key === "back" ? "Delete last digit" : key} className="min-h-12 rounded-xl border border-wayne-border bg-white text-2xl font-black shadow-sm active:translate-y-px" key={key} onClick={() => press(key)} type="button">{key === "back" ? "⌫" : key}</button>)}
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-1.5">
            <Button className="min-h-14" onClick={() => press("clear")} variant="ghost">Clear</Button>
            <Button className="min-h-14 text-lg" disabled={busy || change === null} onClick={() => { void recordCash(); }}>{busy ? "Saving…" : change === null ? "Record cash" : `Record cash · change ${formatCents(change)}`}</Button>
          </div>
        </div>
      </div> : null}
    </section>
  </div>;
}
