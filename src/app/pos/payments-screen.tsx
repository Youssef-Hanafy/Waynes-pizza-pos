"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { StripeCardField, type StripeCardConfirm } from "@/components/payments/stripe-card-field";
import { StripeReaderTender } from "@/components/pos/stripe-reader-panel";
import { posDrawerSchema } from "@/lib/cash/schemas";
import { formatCents } from "@/lib/menu/schemas";
import { openOrderSchema, type OpenOrder } from "@/lib/orders/status";
import type { CheckoutPaymentConfig } from "@/lib/payments/schemas";
import { changeDueCents, quickCashAmounts } from "@/lib/pos/tender";
import { requestReceipt } from "@/lib/printing/request-receipt";

const terminalSchema = z.object({ id: z.uuid(), label: z.string() });
type Terminal = z.infer<typeof terminalSchema>;

type Done = { order: OpenOrder; method: "cash" | "card"; changeCents: number; tenderedCents: number | null };
type Mode = "choose" | "cash" | "terminal" | "keyed";
type KeyedConfig = Extract<CheckoutPaymentConfig, { provider: "stripe" }>;

const statusLabels: Record<string, string> = { placed: "New", accepted: "Accepted", in_kitchen: "Cooking", ready: "Ready", out_for_delivery: "Out for delivery", payment_pending: "Paying online" };

async function readError(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : fallback;
}

/**
 * The Payments screen (owner, 2026-09-23).  Every open order on the left;
 * pick one and take the money on the right:
 *
 *   Cash  → type or tap what the customer handed over, the change shows as you
 *           go, Record cash.
 *   Card  → send the total to a card reader linked to the POS, or — while the
 *           reader isn't linked (Boston North's standalone terminals) — run
 *           the total on the reader and tap Approved.
 *
 * Every payment taken here opens the cash drawer: the database queues a
 * drawer kick and the print station pulses the drawer on the receipt printer.
 */
export function PaymentsScreen({ timeZone, initialOrderId = null, keyedCardConfig, stripeReader = false }: { timeZone: string; initialOrderId?: string | null; keyedCardConfig: Extract<CheckoutPaymentConfig, { provider: "stripe" }> | null; /** Admin → Hardware → Payment terminal is the Stripe Reader M2. */ stripeReader?: boolean }) {
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(initialOrderId);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [shiftId, setShiftId] = useState("");
  const [showPaid, setShowPaid] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/pos/open-orders", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      const body: unknown = await response.json();
      const parsed = openOrderSchema.array().safeParse(body);
      if (!response.ok || !parsed.success) throw new Error("Open orders are unavailable.");
      if (mounted.current) { setOrders(parsed.data); setListError(""); setLoaded(true); }
    } catch (cause) {
      if (mounted.current) { setListError(cause instanceof Error ? cause.message : "Open orders are unavailable."); setLoaded(true); }
    }
  }, []);

  const loadDrawer = useCallback(async () => {
    try {
      const response = await fetch("/api/pos/drawer", { cache: "no-store" });
      const parsed = posDrawerSchema.safeParse(response.ok ? await response.json() : null);
      if (mounted.current && parsed.success) setShiftId(parsed.data.shift?.id ?? "");
    } catch { /* cash stays unavailable until the drawer answers */ }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const first = window.setTimeout(() => { void load(); void loadDrawer(); }, 0);
    const timer = window.setInterval(() => { void load(); }, 10_000);
    // Readers linked to the POS (listed only when reader payment is switched on).
    fetch("/api/pos/terminal", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : []))
      .then((body: unknown) => { const parsed = terminalSchema.array().safeParse(body); if (mounted.current && parsed.success) setTerminals(parsed.data); })
      .catch(() => undefined);
    return () => { mounted.current = false; window.clearTimeout(first); window.clearInterval(timer); };
  }, [load, loadDrawer]);

  const unpaid = orders.filter((order) => order.payment_status !== "paid" && order.status !== "payment_pending");
  const paid = orders.filter((order) => order.payment_status === "paid");
  const selected = orders.find((order) => order.id === selectedId) ?? null;
  const time = (value: string) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value));

  function finished(result: Done) {
    setDone(result);
    setSelectedId(null);
    void load();
  }

  const row = (order: OpenOrder) => <li key={order.id}>
    <button aria-current={order.id === selectedId ? "true" : undefined} className={`flex min-h-16 w-full items-center justify-between gap-3 rounded-xl border-2 p-3 text-left transition ${order.id === selectedId ? "border-wayne-green bg-wayne-ok-soft" : "border-wayne-border bg-white hover:border-wayne-border-strong"}`} onClick={() => { setSelectedId(order.id); setDone(null); }} type="button">
      <span className="min-w-0"><strong className="block text-lg">{order.order_number} · {order.customer_name || "Walk-in"}</strong><span className="block text-sm capitalize text-wayne-muted">{order.fulfillment_type} · {order.source} · {time(order.placed_at)} · {statusLabels[order.status] ?? order.status}</span></span>
      <span className="text-right"><strong className="block text-xl">{formatCents(order.total_cents)}</strong><span className={`text-xs font-black uppercase ${order.payment_status === "paid" ? "text-wayne-ok" : "text-wayne-red"}`}>{order.payment_status === "paid" ? `Paid · ${order.payment_method}` : "Unpaid"}</span></span>
    </button>
  </li>;

  return <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[minmax(20rem,28rem)_1fr] lg:overflow-hidden">
    <section aria-label="Orders to pay" className="flex flex-col rounded-2xl bg-white p-3 shadow-sm lg:min-h-0">
      <div className="flex items-center justify-between gap-2"><h1 className="text-2xl font-black">Payments</h1><span className="text-sm font-bold text-wayne-muted">{unpaid.length} unpaid</span></div>
      {listError ? <p className="mt-2 rounded-xl bg-wayne-alert-soft p-2 text-sm font-bold text-wayne-alert" role="alert">{listError}</p> : null}
      <ul className="mt-3 grid gap-2 pr-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {unpaid.map(row)}
        {loaded && !unpaid.length && !listError ? <li className="rounded-xl border border-dashed border-wayne-border p-6 text-center text-wayne-muted">Every open order is paid.</li> : null}
        {paid.length ? <li><button className="mt-2 min-h-11 text-sm font-bold underline" onClick={() => setShowPaid((value) => !value)} type="button">{showPaid ? "Hide" : "Show"} paid orders ({paid.length})</button></li> : null}
        {showPaid ? paid.map(row) : null}
      </ul>
    </section>

    <section aria-label="Take payment" className="rounded-2xl bg-white p-4 shadow-sm lg:min-h-0 lg:overflow-y-auto">
      {done ? <PaidSummary done={done} onNext={() => setDone(null)} />
        : selected ? <PaymentPage keyedCardConfig={keyedCardConfig} key={selected.id} stripeReader={stripeReader} onDrawerChanged={loadDrawer} onPaid={finished} order={selected} shiftId={shiftId} terminals={terminals} />
        : <div className="grid h-full place-items-center p-8 text-center text-wayne-muted"><p className="text-lg font-bold">Choose an order on the left to take payment.</p></div>}
    </section>
  </div>;
}

function PaidSummary({ done, onNext }: { done: Done; onNext: () => void }) {
  const [note, setNote] = useState("");
  return <div className="mx-auto max-w-xl text-center">
    <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-ok">Paid · {done.order.order_number}</p>
    {done.method === "cash" ? <>
      <p className="mt-6 text-lg font-bold">Change due</p>
      <p className="text-7xl font-black text-wayne-ok">{formatCents(done.changeCents)}</p>
      <p className="mt-2 text-wayne-muted">Received {formatCents(done.tenderedCents ?? done.order.total_cents)} for {formatCents(done.order.total_cents)}</p>
    </> : <p className="mt-6 text-5xl font-black">{formatCents(done.order.total_cents)} on card</p>}
    <p className="mt-6 rounded-xl bg-wayne-cream p-3 font-bold">The cash drawer is opening.</p>
    <div className="mt-6 grid gap-2 sm:grid-cols-2">
      <Button onClick={() => { setNote("Printing…"); void requestReceipt(done.order.id).then((result) => setNote(result.message)); }} size="lg" variant="secondary">Print receipt</Button>
      <Button onClick={onNext} size="lg">Next order</Button>
    </div>
    {note ? <p aria-live="polite" className="mt-2 text-sm font-bold">{note}</p> : null}
  </div>;
}

function PaymentPage({ order, shiftId, terminals, onPaid, onDrawerChanged, keyedCardConfig, stripeReader, onPayLater }: { order: OpenOrder; shiftId: string; terminals: Terminal[]; onPaid: (done: Done) => void; onDrawerChanged: () => Promise<void>; keyedCardConfig: KeyedConfig | null; stripeReader: boolean; /** Shown when the payment prompt opens right after an order is sent. */ onPayLater?: () => void }) {
  const [mode, setMode] = useState<Mode>("choose");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const due = order.total_cents;
  const alreadyPaid = order.payment_status === "paid";

  const option = (value: Exclude<Mode, "choose">, icon: string, title: string, note: string, disabled = false) => (
    <button aria-pressed={mode === value} className={`flex min-h-24 flex-col items-center justify-center rounded-2xl border-2 p-2 text-center transition disabled:opacity-40 ${mode === value ? "border-wayne-green bg-wayne-green text-white" : "border-wayne-border bg-wayne-cream hover:border-wayne-green"}`} disabled={disabled || (busy && mode !== value)} key={value} onClick={() => { setMode(value); setError(""); }} type="button">
      <span aria-hidden className="text-2xl leading-none">{icon}</span>
      <strong className="mt-1 text-lg font-black leading-tight">{title}</strong>
      <span className={`text-xs font-bold ${mode === value ? "text-white/80" : "text-wayne-muted"}`}>{note}</span>
    </button>
  );

  return <div>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">{order.order_number} · {order.customer_name || "Walk-in"}</p><p className="mt-1 text-sm capitalize text-wayne-muted">{order.fulfillment_type} · {order.source === "pos" ? "in store" : order.source}</p></div>
      <div className="text-right"><p className="text-sm font-bold">Amount due</p><p className="text-5xl font-black">{formatCents(due)}</p></div>
    </div>
    {alreadyPaid ? <p className="mt-6 rounded-xl bg-wayne-ok-soft p-4 text-lg font-bold text-wayne-ok">Already paid ({order.payment_method}).</p> : <>
      <div className={`mt-5 grid grid-cols-2 gap-3 ${onPayLater ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
        {option("cash", "💵", "Cash", "Change shown")}
        {option("terminal", "💳", "Card reader", stripeReader ? "Tap, insert, swipe" : "Run on the terminal")}
        {option("keyed", "⌨️", "Key in card", keyedCardConfig ? "Card over the phone" : "Needs Stripe", !keyedCardConfig)}
        {onPayLater ? <button className="flex min-h-24 flex-col items-center justify-center rounded-2xl border-2 border-dashed border-wayne-border-strong bg-white p-2 text-center transition hover:border-wayne-green disabled:opacity-40" disabled={busy} onClick={onPayLater} type="button"><span aria-hidden className="text-2xl leading-none">⏱</span><strong className="mt-1 text-lg font-black leading-tight">Pay later</strong><span className="text-xs font-bold text-wayne-muted">At pickup / the door</span></button> : null}
      </div>
      {error ? <p className="mt-4 rounded-xl bg-wayne-alert-soft p-3 font-bold text-wayne-alert" role="alert">{error}</p> : null}
      {mode === "cash" ? <CashTender busy={busy} due={due} onDrawerChanged={onDrawerChanged} onError={setError} onPaid={onPaid} order={order} setBusy={setBusy} shiftId={shiftId} /> : null}
      {mode === "terminal" ? <CardTender busy={busy} onError={setError} onPaid={onPaid} order={order} setBusy={setBusy} stripeReader={stripeReader} terminals={terminals} /> : null}
      {mode === "keyed" && keyedCardConfig ? <div className="mt-5"><KeyedStripeTender busy={busy} config={keyedCardConfig} onError={setError} onPaid={onPaid} order={order} setBusy={setBusy} /></div> : null}
    </>}
  </div>;
}

/**
 * The payment prompt that opens the moment an order is sent (owner,
 * 2026-09-30): Cash, Card reader, Key in card, or Pay later.  Pay later
 * leaves the order unpaid; it is in Payments whenever the customer pays.
 */
export function PaymentPrompt({ order, keyedCardConfig, stripeReader, onPayLater, onFinished }: { order: OpenOrder; keyedCardConfig: KeyedConfig | null; stripeReader: boolean; onPayLater: () => void; onFinished: () => void }) {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [shiftId, setShiftId] = useState("");
  const [done, setDone] = useState<Done | null>(null);
  const mounted = useRef(true);

  const loadDrawer = useCallback(async () => {
    try {
      const response = await fetch("/api/pos/drawer", { cache: "no-store" });
      const parsed = posDrawerSchema.safeParse(response.ok ? await response.json() : null);
      if (mounted.current && parsed.success) setShiftId(parsed.data.shift?.id ?? "");
    } catch { /* cash stays unavailable until the drawer answers */ }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const first = window.setTimeout(() => { void loadDrawer(); }, 0);
    fetch("/api/pos/terminal", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : []))
      .then((body: unknown) => { const parsed = terminalSchema.array().safeParse(body); if (mounted.current && parsed.success) setTerminals(parsed.data); })
      .catch(() => undefined);
    return () => { mounted.current = false; window.clearTimeout(first); };
  }, [loadDrawer]);

  if (done) return <PaidSummary done={done} onNext={onFinished} />;
  return <PaymentPage keyedCardConfig={keyedCardConfig} onDrawerChanged={loadDrawer} onPaid={setDone} onPayLater={onPayLater} order={order} shiftId={shiftId} stripeReader={stripeReader} terminals={terminals} />;
}

type TenderProps = { order: OpenOrder; busy: boolean; setBusy: (value: boolean) => void; onError: (message: string) => void; onPaid: (done: Done) => void };

function CashTender({ order, due, shiftId, busy, setBusy, onError, onPaid, onDrawerChanged }: TenderProps & { due: number; shiftId: string; onDrawerChanged: () => Promise<void> }) {
  // Keyed in like a register: digits fill from the cents up (2-0-0-0 = $20.00).
  const [digits, setDigits] = useState("");
  const tendered = digits ? Number.parseInt(digits, 10) : 0;
  const change = changeDueCents(due, tendered);

  function press(key: string) {
    onError("");
    if (key === "clear") { setDigits(""); return; }
    if (key === "back") { setDigits((value) => value.slice(0, -1)); return; }
    setDigits((value) => (value + key).replace(/^0+/, "").slice(0, 7));
  }

  async function record() {
    if (change === null) { onError(`Still owed ${formatCents(due - tendered)}.`); return; }
    if (!shiftId) { await onDrawerChanged(); onError("Open the drawer first (the Drawer button at the top), then take cash."); return; }
    setBusy(true); onError("");
    try {
      const response = await fetch("/api/pos/drawer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cash_payment", shift_id: shiftId, order_id: order.id, tendered_cents: tendered, idempotency_key: `pos-cash-${order.id}-${tendered}` }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(await readError(response, "The cash could not be recorded."));
      const body = await response.json().catch(() => ({})) as { result?: { change_cents?: number } };
      onPaid({ order, method: "cash", changeCents: Number(body.result?.change_cents ?? change), tenderedCents: tendered });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "The cash could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="mt-5 grid gap-4 xl:grid-cols-[1fr_18rem]">
    <div>
      <div className="rounded-2xl border-2 border-wayne-border p-4">
        <p className="text-sm font-bold">Cash received</p>
        <p aria-live="polite" className="text-5xl font-black tabular-nums">{formatCents(tendered)}</p>
        <p aria-live="polite" className={`mt-3 text-3xl font-black ${change === null ? "text-wayne-red" : "text-wayne-ok"}`}>{change === null ? (tendered ? `Still owed ${formatCents(due - tendered)}` : "Enter the cash handed over") : `Change ${formatCents(change)}`}</p>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {quickCashAmounts(due).map((amount) => <Button key={amount} onClick={() => { onError(""); setDigits(String(amount)); }} size="lg" variant="secondary">{amount === due ? "Exact" : formatCents(amount)}</Button>)}
      </div>
      {!shiftId ? <p className="mt-3 rounded-xl bg-wayne-warn-soft p-3 text-sm font-bold">The drawer isn&apos;t open on this register yet. Open it with the Drawer button at the top before taking cash.</p> : null}
    </div>
    <div>
      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "back"].map((key) => <button aria-label={key === "back" ? "Delete last digit" : key} className="min-h-16 rounded-xl border border-wayne-border bg-white text-2xl font-black shadow-sm active:translate-y-px" key={key} onClick={() => press(key)} type="button">{key === "back" ? "⌫" : key}</button>)}
      </div>
      <Button className="mt-2 w-full" onClick={() => press("clear")} variant="ghost">Clear</Button>
      <Button className="mt-2 w-full text-xl" disabled={busy || change === null} onClick={() => { void record(); }} size="lg">{busy ? "Saving…" : change === null ? "Record cash" : `Record cash · change ${formatCents(change)}`}</Button>
    </div>
  </div>;
}

function CardTender({ order, terminals, busy, setBusy, onError, onPaid, stripeReader }: TenderProps & { terminals: Terminal[]; stripeReader: boolean }) {
  const [terminalId, setTerminalId] = useState(terminals[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [charging, setCharging] = useState(false);
  const [last4, setLast4] = useState("");
  const [approval, setApproval] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  /** A reader linked to the POS: send it the total, then wait for the customer. */
  async function sendToReader() {
    if (!terminalId) return;
    setCharging(true); setBusy(true); onError(""); setNote("Sending the total to the reader…");
    const idempotencyKey = `pos-terminal-${order.id}-${Date.now()}`;
    const call = (action: "start" | "status") => fetch("/api/pos/terminal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id: order.id, terminal_id: terminalId, idempotency_key: idempotencyKey, action }),
      signal: AbortSignal.timeout(20_000),
    });
    try {
      const start = await call("start");
      if (!start.ok) throw new Error(await readError(start, "The card reader could not be reached."));
      setNote("Waiting for the customer to tap, dip or swipe…");
      const deadline = Date.now() + 5 * 60_000;
      while (alive.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const poll = await call("status");
        if (!poll.ok) throw new Error(await readError(poll, "The card reader could not be reached."));
        const body = await poll.json().catch(() => ({})) as { state?: string };
        if (body.state === "captured") { onPaid({ order, method: "card", changeCents: 0, tenderedCents: null }); return; }
        if (body.state === "voided") throw new Error("The customer cancelled at the reader.");
        if (body.state === "failed") throw new Error("The card was declined at the reader.");
      }
      throw new Error("The reader did not answer in time. Check it before charging again.");
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "The card reader could not be reached.");
    } finally {
      if (alive.current) { setCharging(false); setBusy(false); setNote(""); }
    }
  }

  async function cancelOnReader() {
    try {
      await fetch("/api/pos/terminal", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: order.id, terminal_id: terminalId, idempotency_key: `pos-terminal-cancel-${order.id}-${Date.now()}`, action: "cancel" }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { /* the wait loop reports whatever the reader ends up saying */ }
  }

  /** A standalone reader (not linked yet): the total was keyed in and approved. */
  async function recordApproved() {
    setBusy(true); onError("");
    try {
      const response = await fetch("/api/pos/payments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: order.id, idempotency_key: `pos-card-reader-${order.id}`, card_last4: last4.trim(), approval_code: approval.trim(), processor: "Card reader" }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(await readError(response, "The card payment could not be recorded."));
      onPaid({ order, method: "card", changeCents: 0, tenderedCents: null });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "The card payment could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  const manualReader = <div className="rounded-2xl border-2 border-wayne-border p-4">
      <h2 className="text-xl font-black">{terminals.length || stripeReader ? "Ran it on a separate terminal" : "Card reader"}</h2>
      <ol className="mt-2 list-decimal pl-5 text-base">
        <li>Key <strong>{formatCents(order.total_cents)}</strong> into the card reader and let the customer pay.</li>
        <li>When the reader says <strong>Approved</strong>, tap the button below.</li>
      </ol>
      <p className="mt-1 text-sm text-wayne-muted">The reader isn&apos;t linked to the POS yet, so it can&apos;t be sent the total automatically. Only tap Approved after the reader approves.</p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-sm font-bold">Last 4 of card (optional)<input className="min-h-12 rounded-lg border border-wayne-border px-3 text-lg font-bold tracking-widest" inputMode="numeric" maxLength={4} onChange={(event) => setLast4(event.target.value.replace(/\D/g, ""))} value={last4} /></label>
        <label className="grid gap-1 text-sm font-bold">Approval code (optional)<input className="min-h-12 rounded-lg border border-wayne-border px-3 text-lg font-bold uppercase" maxLength={40} onChange={(event) => setApproval(event.target.value)} value={approval} /></label>
      </div>
      <Button className="mt-3 w-full text-xl" disabled={busy || (last4.length > 0 && last4.length < 4)} onClick={() => { void recordApproved(); }} size="lg">{busy && !charging ? "Saving…" : `Approved on the reader · ${formatCents(order.total_cents)}`}</Button>
</div>;

  return <div className="mt-5 grid gap-4">
    {stripeReader ? <StripeReaderTender busy={busy} onError={onError} onPaid={() => onPaid({ order, method: "card", changeCents: 0, tenderedCents: null })} orderId={order.id} setBusy={setBusy} totalCents={order.total_cents} /> : null}
    {terminals.length ? <div className="rounded-2xl border-2 border-wayne-green p-4">
      <h2 className="text-xl font-black">Send to the card reader</h2>
      {terminals.length > 1 ? <label className="mt-2 grid gap-1 text-sm font-bold">Reader<select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3" onChange={(event) => setTerminalId(event.target.value)} value={terminalId}>{terminals.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.label}</option>)}</select></label> : null}
      {charging ? <div className="mt-3 flex flex-wrap items-center gap-3"><p aria-live="polite" className="text-lg font-bold">{note}</p><Button onClick={() => { void cancelOnReader(); }} variant="secondary">Cancel on reader</Button></div>
        : <Button className="mt-3 w-full text-xl" disabled={busy} onClick={() => { void sendToReader(); }} size="lg">Charge {formatCents(order.total_cents)} on the reader</Button>}
    </div> : null}

    {stripeReader ? <details className="rounded-2xl border border-dashed border-wayne-border-strong p-3"><summary className="min-h-9 cursor-pointer text-sm font-bold">Reader not working? Record a card run on a separate terminal</summary><div className="mt-3">{manualReader}</div></details> : manualReader}
  </div>;
}

/** Keyed-in cards (usually over the phone) are typed into Stripe's own secure field, never into Wayne's app. */
function KeyedStripeTender({ order, config, busy, setBusy, onError, onPaid }: TenderProps & { config: Extract<CheckoutPaymentConfig, { provider: "stripe" }> }) {
  const confirmRef = useRef<StripeCardConfirm | null>(null);
  const [message, setMessage] = useState("");
  const onReady = useCallback((confirm: StripeCardConfirm | null) => { confirmRef.current = confirm; }, []);
  const onStatus = useCallback((next: string) => setMessage(next), []);

  async function charge() {
    if (!confirmRef.current) { onError("Secure card entry is still loading."); return; }
    setBusy(true); onError(""); setMessage("Preparing Stripe payment…");
    try {
      const intentResponse = await fetch("/api/pos/keyed-card/intent", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: order.id, idempotency_key: `pos-keyed-card-${order.id}-${crypto.randomUUID()}` }), signal: AbortSignal.timeout(15_000),
      });
      if (!intentResponse.ok) throw new Error(await readError(intentResponse, "The payment could not be prepared."));
      const intent = await intentResponse.json().catch(() => null) as { payment_id?: string; client_secret?: string } | null;
      if (!intent?.payment_id || !intent.client_secret) throw new Error("The payment could not be prepared.");
      setMessage("Waiting for Stripe…");
      const confirmed = await confirmRef.current({ clientSecret: intent.client_secret, name: order.customer_name || "Customer" });
      // Declined or not, ask the server to read Stripe: a decline closes this attempt so the next card can be tried.
      const confirmResponse = await fetch("/api/pos/keyed-card/confirm", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payment_id: intent.payment_id }), signal: AbortSignal.timeout(15_000),
      });
      if (confirmed.error) throw new Error(confirmed.error.message ?? "The card was declined. Try another card.");
      if (!confirmResponse.ok) throw new Error(await readError(confirmResponse, "We could not verify the payment."));
      const result = await confirmResponse.json().catch(() => null) as { payment_status?: string } | null;
      if (result?.payment_status === "captured") { onPaid({ order, method: "card", changeCents: 0, tenderedCents: null }); return; }
      if (result?.payment_status === "pending") throw new Error("Stripe is still processing this payment. Do not enter the card again; check Payments shortly.");
      throw new Error("The card was declined. Try another card.");
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "The keyed card payment could not be completed.");
    } finally {
      setBusy(false); setMessage("");
    }
  }

  return <div className="rounded-2xl border-2 border-wayne-green p-4">
    <h2 className="text-xl font-black">Key in the card</h2>
    <p className="mt-1 text-sm text-wayne-muted">Type the card number, expiry, CVC and ZIP the customer reads out. The details go straight to Stripe and are never stored by the POS.</p>
    <div className="mt-3"><StripeCardField config={config} onReady={onReady} onStatus={onStatus} /></div>
    {message ? <p aria-live="polite" className="mt-2 text-sm font-bold">{message}</p> : null}
    <Button className="mt-3 w-full text-xl" disabled={busy} onClick={() => { void charge(); }} size="lg">{busy ? "Processing…" : `Charge ${formatCents(order.total_cents)} with Stripe`}</Button>
  </div>;
}
