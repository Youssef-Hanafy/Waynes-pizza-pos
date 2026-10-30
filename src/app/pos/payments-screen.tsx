"use client";

import { logDevice } from "@/lib/pos/device-log";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useVisiblePolling } from "@/components/ops/use-visible-polling";
import { Button } from "@/components/ui/button";
import { StripeCardField, type StripeCardConfirm } from "@/components/payments/stripe-card-field";
import { StripeReaderTender } from "@/components/pos/stripe-reader-panel";
import { posDrawerSchema } from "@/lib/cash/schemas";
import { formatCents } from "@/lib/menu/schemas";
import { openOrderSchema, type OpenOrder } from "@/lib/orders/status";
import type { CheckoutPaymentConfig } from "@/lib/payments/schemas";
import { changeDueCents, quickCashAmounts } from "@/lib/pos/tender";
import { requestReceipt } from "@/lib/printing/request-receipt";
import { uuid } from "@/lib/uuid";
import { ticketLabel, ticketNumber } from "@/lib/orders/ticket-number";
import { showOnCustomerScreen, useCustomerScreen } from "@/stores/customer-display-link";
import { CustomerSignStep, CustomerTipStep, thankCustomer } from "./customer-steps";
import { tipRoute } from "@/lib/pos/checkout-steps";

const terminalSchema = z.object({ id: z.uuid(), label: z.string() });
type Terminal = z.infer<typeof terminalSchema>;

export type Done = { order: OpenOrder; method: "cash" | "card"; changeCents: number; tenderedCents: number | null;
  /** A delivery card approved for the order — charged with the tip on the slip at the driver's cash-out. */
  held?: boolean };
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
 * Only cash opens the cash drawer (owner, 2026-10-12): recording the cash
 * handed over queues a drawer kick and the print station pulses the drawer on
 * the receipt printer.  Sending an order or a card payment never opens it.
 */
export function PaymentsScreen({ timeZone, initialOrderId = null, keyedCardConfig, stripeReader = false, onAddItems }: { timeZone: string; initialOrderId?: string | null; keyedCardConfig: Extract<CheckoutPaymentConfig, { provider: "stripe" }> | null; /** Admin → Hardware → Payment terminal is the Stripe Reader M2. */ stripeReader?: boolean; /** Add items to an unpaid order, then pay it all at once. */ onAddItems?: (order: OpenOrder) => void }) {
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(initialOrderId);
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [shiftId, setShiftId] = useState("");
  const [showPaid, setShowPaid] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  /**
   * Opened on one order (Today's Orders / Orders → Take payment): just that
   * order's payment, across the whole screen in one box, so nothing has to be
   * scrolled (owner, 2026-10-24).  "All payments" goes back to the list.
   */
  const [focused, setFocused] = useState(Boolean(initialOrderId));
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
    const first = window.setTimeout(() => { void loadDrawer(); }, 0);
    // Readers linked to the POS (listed only when reader payment is switched on).
    fetch("/api/pos/terminal", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : []))
      .then((body: unknown) => { const parsed = terminalSchema.array().safeParse(body); if (mounted.current && parsed.success) setTerminals(parsed.data); })
      .catch(() => undefined);
    return () => { mounted.current = false; window.clearTimeout(first); };
  }, [load, loadDrawer]);

  useVisiblePolling(load, 30_000);

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
      <span className="min-w-0"><strong className="block text-lg">{ticketLabel(order)} · {order.customer_name || "Walk-in"}</strong><span className="block text-sm capitalize text-wayne-muted">{order.fulfillment_type} · {order.source} · {time(order.placed_at)} · {statusLabels[order.status] ?? order.status}</span></span>
      <span className="text-right"><strong className="block text-xl">{formatCents(order.payment_status === "paid" ? order.total_cents : Math.max(0, order.total_cents - order.paid_cents))}</strong><span className={`text-xs font-black uppercase ${order.payment_status === "paid" ? "text-wayne-ok" : "text-wayne-red"}`}>{order.payment_status === "paid" ? `Paid · ${order.payment_method}` : order.paid_cents > 0 ? `Still owed · ${formatCents(order.paid_cents)} paid` : "Unpaid"}</span></span>
    </button>
  </li>;

  if (focused && (done || selected || !loaded)) {
    return <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto bg-wayne-cream-deep p-2">
      <section aria-label="Take payment" className="w-full rounded-3xl border border-wayne-border bg-white px-4 py-3 shadow-xl">
        <div className="mb-2 flex justify-end"><Button onClick={() => { setFocused(false); setDone(null); }} size="sm" variant="secondary">‹ All payments</Button></div>
        {done ? <PaidSummary done={done} onNext={() => { setDone(null); setFocused(false); }} />
          : selected ? <PaymentPage keyedCardConfig={keyedCardConfig} key={selected.id} onAddItems={onAddItems ? () => onAddItems(selected) : undefined} stripeReader={stripeReader} onDrawerChanged={loadDrawer} onPaid={finished} order={selected} shiftId={shiftId} terminals={terminals} />
          : <p className="p-6 text-center font-bold text-wayne-muted">Loading the order…</p>}
      </section>
    </div>;
  }

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
        : selected ? <PaymentPage keyedCardConfig={keyedCardConfig} key={selected.id} onAddItems={onAddItems ? () => onAddItems(selected) : undefined} stripeReader={stripeReader} onDrawerChanged={loadDrawer} onPaid={finished} order={selected} shiftId={shiftId} terminals={terminals} />
        : <div className="grid h-full place-items-center p-8 text-center text-wayne-muted"><p className="text-lg font-bold">Choose an order on the left to take payment.</p></div>}
    </section>
  </div>;
}

function PaidSummary({ done, onNext }: { done: Done; onNext: () => void }) {
  const [note, setNote] = useState("");
  // A card in the store needs nothing more from the cashier (owner, 2026-10-13):
  // the screen moves on to the next order by itself.  Cash waits — the change has to be handed over.
  const autoNext = done.method === "card" && !done.held;
  const [nextIn, setNextIn] = useState(autoNext ? 5 : 0);
  const onNextRef = useRef(onNext);
  useEffect(() => { onNextRef.current = onNext; }, [onNext]);
  useEffect(() => {
    if (!autoNext || nextIn <= 0) return;
    const timer = window.setTimeout(() => { if (nextIn <= 1) onNextRef.current(); else setNextIn(nextIn - 1); }, 1000);
    return () => window.clearTimeout(timer);
  }, [autoNext, nextIn]);
  return <div className="mx-auto max-w-xl text-center">
    <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-ok">Paid · {ticketLabel(done.order)}</p>
    {done.method === "cash" ? <>
      <p className="mt-6 text-lg font-bold">Change due</p>
      <p className="text-7xl font-black text-wayne-ok">{formatCents(done.changeCents)}</p>
      <p className="mt-2 text-wayne-muted">Received {formatCents(done.tenderedCents ?? done.order.total_cents)} for {formatCents(done.order.total_cents)}</p>
    </> : done.held ? <>
      <p className="mt-6 text-5xl font-black">Card approved · {formatCents(done.order.total_cents)}</p>
      <p className="mt-2 text-wayne-muted">{done.order.fulfillment_type === "delivery"
        ? "A tip & signature slip prints for the driver. When they bring it back signed, type the tip in Deliveries and cash them out — the card is charged once, order + tip."
        : "A tip & signature slip prints. Keep the signed slip: at the end of the night type its tip in Tips — the card is charged once, order + tip."}</p>
    </> : <>
      <p className="mt-6 text-5xl font-black">{formatCents(done.order.total_cents)} on card</p>
      <p className="mt-2 font-bold text-wayne-ok">Charged — order closed. It&apos;s in Today&apos;s Orders.</p>
    </>}
    {done.order.is_test ? <p className="mt-3 rounded-xl bg-wayne-warn-soft p-2 text-sm font-bold">🧪 Test order — no real card was charged.</p> : null}
    {done.method === "cash" ? <p className="mt-6 rounded-xl bg-wayne-cream p-3 font-bold">The cash drawer is opening.</p> : null}
    <div className="mt-6 grid gap-2 sm:grid-cols-2">
      <Button onClick={() => { setNote("Printing…"); void requestReceipt(done.order.id).then((result) => setNote(result.message)); }} size="lg" variant="secondary">Print receipt</Button>
      <Button onClick={onNext} size="lg">{autoNext && nextIn > 0 ? `Next order (${nextIn})` : "Next order"}</Button>
    </div>
    {note ? <p aria-live="polite" className="mt-2 text-sm font-bold">{note}</p> : null}
  </div>;
}

function PaymentPage({ order: openedOrder, shiftId, terminals, onPaid: finishPayment, onDrawerChanged, keyedCardConfig, stripeReader, onPayLater, onAddItems }: { order: OpenOrder; shiftId: string; terminals: Terminal[]; onPaid: (done: Done) => void; onDrawerChanged: () => Promise<void>; keyedCardConfig: KeyedConfig | null; stripeReader: boolean; /** Shown when the payment prompt opens right after an order is sent. */ onPayLater?: () => void; /** Back to the menu to add items to this same unpaid order, then one payment for everything (owner, 2026-10-16). */ onAddItems?: () => void }) {
  const [mode, setMode] = useState<Mode>("choose");
  const [error, setError] = useState("");
  // Every message shown here goes to the device log too, so a "couldn't" on the Elo can be read back (owner, 2026-10-28).
  useEffect(() => { if (error) logDevice("pos.error_shown", error, { screen: "payments", order: openedOrder.order_number, daily: openedOrder.daily_number ?? null }); }, [error, openedOrder.order_number, openedOrder.daily_number]);
  const [busy, setBusy] = useState(false);
  // The customer screen (owner, 2026-10-11): a tip before the card, a signature after.
  const screen = useCustomerScreen();
  // Items added after a payment (owner, 2026-10-19): the same order, and this screen takes only what is still owed.
  const paidBefore = openedOrder.payment_status === "paid" ? 0 : Math.max(0, openedOrder.paid_cents);
  const [order, setOrder] = useState<OpenOrder>(() => paidBefore ? { ...openedOrder, total_cents: openedOrder.total_cents - paidBefore } : openedOrder);
  const [tipAsked, setTipAsked] = useState(false);
  const [signing, setSigning] = useState<Done | null>(null);
  useEffect(() => {
    if (openedOrder.payment_status !== "paid") showOnCustomerScreen({ phase: "pay", order_number: ticketNumber(openedOrder), total_cents: openedOrder.total_cents - paidBefore });
  }, [openedOrder, paidBefore]);
  const tipDone = useCallback((next: OpenOrder) => { setOrder(next); setTipAsked(true); }, []);
  const onPaid = useCallback((done: Done) => {
    if (done.method === "card" && !done.held && screen.screenOnline) { setSigning(done); return; }
    if (!done.held) thankCustomer(done.method === "cash" ? done.changeCents : null);
    finishPayment(done);
  }, [finishPayment, screen.screenOnline]);
  const signed = useCallback(() => { if (signing) finishPayment(signing); }, [finishPayment, signing]);
  const due = order.total_cents;

  if (signing) return <CustomerSignStep onFinished={signed} order={signing.order} tipCents={Math.max(0, signing.order.total_cents - (openedOrder.total_cents - paidBefore))} />;
  const alreadyPaid = order.payment_status === "paid";
  const cardHeld = order.payment_status === "authorized";
  // Delivery (owner, 2026-10-11): a phone card is keyed in and the slip's tip is
  // added at the driver's cash-out; cash is collected at the door by the driver.
  const isDelivery = order.fulfillment_type === "delivery";

  // Once a way to pay is picked the buttons shrink to one row, so the cash
  // keypad and Record cash fit on one screen with no scrolling (owner, 2026-10-19).
  const compact = mode !== "choose";
  // Once a way to pay is picked, "Add items" joins the same row (saves a whole row on the cash screen).
  const buttonCount = (onPayLater ? 4 : 3) + (onAddItems && compact ? 1 : 0);
  const buttonColumns = buttonCount === 5 ? "md:grid-cols-5" : buttonCount === 4 ? "md:grid-cols-4" : "md:grid-cols-3";
  const option = (value: Exclude<Mode, "choose">, icon: string, title: string, note: string, disabled = false) => (
    <button aria-pressed={mode === value} className={`flex items-center justify-center rounded-2xl border-2 p-2 text-center transition disabled:opacity-40 ${compact ? "min-h-12 gap-2" : "min-h-24 flex-col"} ${mode === value ? "border-wayne-green bg-wayne-green text-white" : "border-wayne-border bg-wayne-cream hover:border-wayne-green"}`} disabled={disabled || (busy && mode !== value)} key={value} onClick={() => { setMode(value); setError(""); }} type="button">
      <span aria-hidden className={`${compact ? "text-xl" : "text-2xl"} leading-none`}>{icon}</span>
      <strong className={`${compact ? "" : "mt-1 "}text-lg font-black leading-tight`}>{title}</strong>
      {compact ? null : <span className="text-xs font-bold text-wayne-muted">{note}</span>}
    </button>
  );

  return <div>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>{onPayLater && !compact ? <h2 className="mb-1 text-2xl font-black">How are they paying?</h2> : null}<p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">{ticketLabel(order)} · {order.customer_name || "Walk-in"}</p><p className="mt-1 text-sm capitalize text-wayne-muted">{order.fulfillment_type} · {order.source === "pos" ? "in store" : order.source}</p></div>
      <div className="text-right"><p className="text-sm font-bold">{paidBefore ? "Still owed" : "Amount due"}</p><p className={`${compact ? "text-4xl" : "text-5xl"} font-black tabular-nums`}>{formatCents(due)}</p>{paidBefore ? <p className="text-sm font-bold text-wayne-muted">Order {formatCents(openedOrder.total_cents)} · {formatCents(paidBefore)} already paid</p> : null}</div>
    </div>
    {alreadyPaid ? <p className="mt-6 rounded-xl bg-wayne-ok-soft p-4 text-lg font-bold text-wayne-ok">Already paid ({order.payment_method}).</p>
      : cardHeld && !paidBefore ? <p className="mt-6 rounded-xl bg-wayne-ok-soft p-4 text-lg font-bold text-wayne-ok">Paid by card — approved and held for the tip on the signed slip. {isDelivery ? "Add the tip in Deliveries at the driver's cash-out" : "Add the tip in Tips at the end of the night"}; the card is charged once, order + tip.</p> : <>
      {order.is_test ? <p className={`rounded-xl bg-wayne-warn-soft font-bold ${compact ? "mt-2 px-3 py-1.5 text-sm" : "mt-5 p-3"}`}>🧪 Test order — Card reader and Key in card are simulated here. Everything works the same, but no card is charged.</p> : null}
      {onAddItems && !compact ? <button className={`flex w-full flex-wrap items-center justify-center gap-x-2 rounded-2xl border-2 border-wayne-green bg-white px-4 font-black text-wayne-green transition active:scale-[0.99] disabled:opacity-40 mt-4 min-h-14 text-lg`} disabled={busy || tipAsked} onClick={onAddItems} type="button">＋ Add more items to this order<span className="text-sm font-bold text-wayne-muted">same ticket · one payment</span></button> : null}
      <div className={`grid grid-cols-2 ${compact ? "mt-2 gap-2" : "mt-5 gap-3"} ${buttonColumns}`}>
        {onAddItems && compact ? <button className="flex min-h-12 items-center justify-center gap-2 rounded-2xl border-2 border-wayne-green bg-white p-2 text-center font-black text-wayne-green transition active:scale-[0.99] disabled:opacity-40" disabled={busy || tipAsked || mode === "terminal"} onClick={onAddItems} type="button"><span aria-hidden className="text-xl leading-none">＋</span><strong className="text-lg font-black leading-tight">Add items</strong></button> : null}
        {option("cash", "💵", "Cash", isDelivery ? "Paid now, at the counter" : "Change shown")}
        {option("terminal", "💳", "Card reader", isDelivery ? "Customer here · tip on slip" : stripeReader ? "Tap, insert, swipe" : "Run on the terminal")}
        {option("keyed", "⌨️", "Key in card", isDelivery ? (keyedCardConfig || order.is_test ? `Phone order · tip at cash-out${order.is_test ? " (test)" : ""}` : "Needs Stripe") : order.is_test ? "Test card" : keyedCardConfig ? "Card over the phone" : "Needs Stripe", !keyedCardConfig && !order.is_test)}
        {onPayLater ? <button className={`flex items-center justify-center rounded-2xl border-2 border-dashed border-wayne-border-strong bg-white p-2 text-center transition hover:border-wayne-green disabled:opacity-40 ${compact ? "min-h-12 gap-2" : "min-h-24 flex-col"}`} disabled={busy} onClick={onPayLater} type="button"><span aria-hidden className={`${compact ? "text-xl" : "text-2xl"} leading-none`}>{isDelivery ? "🚗" : "⏱"}</span><strong className={`${compact ? "" : "mt-1 "}text-lg font-black leading-tight`}>{isDelivery ? "Cash at the door" : "Pay later"}</strong>{compact ? null : <span className="text-xs font-bold text-wayne-muted">{isDelivery ? "Driver collects · cash out in Deliveries" : "At pickup / the door"}</span>}</button> : null}
      </div>
      {error ? <p className={`${compact ? "mt-2 p-2" : "mt-4 p-3"} rounded-xl bg-wayne-alert-soft font-bold text-wayne-alert`} role="alert">{error}</p> : null}
      {mode === "cash" ? <CashTender busy={busy} due={due} onDrawerChanged={onDrawerChanged} onError={setError} onPaid={onPaid} order={order} setBusy={setBusy} shiftId={shiftId} /> : null}
      {mode === "terminal" ? (tipRoute({ screenOnline: screen.screenOnline, tipAsked, paidBefore }) === "screen"
        ? <CustomerTipStep onDone={tipDone} order={order} />
        // No second tap (owner, 2026-10-12): once the tip is picked the total goes straight to the reader.
        : order.is_test ? <TestCardTender autoStart busy={busy} entry="card_reader" onError={setError} onPaid={onPaid} order={order} setBusy={setBusy} />
        : <CardTender autoStart busy={busy} onError={setError} onPaid={onPaid} order={order} setBusy={setBusy} stripeReader={stripeReader} terminals={terminals} />) : null}
      {mode === "keyed" && order.is_test ? <div className="mt-5"><TestCardTender busy={busy} entry="test_keyed" onError={setError} onPaid={onPaid} order={order} setBusy={setBusy} /></div>
        : mode === "keyed" && keyedCardConfig ? <div className="mt-5"><KeyedStripeTender busy={busy} config={keyedCardConfig} onError={setError} onPaid={onPaid} order={order} setBusy={setBusy} /></div> : null}
    </>}
  </div>;
}

/**
 * The payment prompt that opens the moment an order is sent (owner,
 * 2026-09-30): Cash, Card reader, Key in card, or Pay later.  Pay later
 * leaves the order unpaid; it is in Payments whenever the customer pays.
 */
export function PaymentPrompt({ order, keyedCardConfig, stripeReader, onPayLater, onFinished, onAddItems }: { order: OpenOrder; keyedCardConfig: KeyedConfig | null; stripeReader: boolean; onPayLater: () => void; /** Paid: straight back to taking orders, no "Next order" screen (owner, 2026-10-19). */ onFinished: (done: Done) => void; onAddItems?: () => void }) {
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [shiftId, setShiftId] = useState("");
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

  return <PaymentPage keyedCardConfig={keyedCardConfig} onAddItems={onAddItems} onDrawerChanged={loadDrawer} onPaid={onFinished} onPayLater={onPayLater} order={order} shiftId={shiftId} stripeReader={stripeReader} terminals={terminals} />;
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
    // No drawer count needed first: with no open drawer the database opens
    // one at $0.00 so a sale is never blocked (owner, 2026-10-11).
    setBusy(true); onError("");
    try {
      const response = await fetch("/api/pos/drawer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cash_payment", shift_id: shiftId, order_id: order.id, tendered_cents: tendered, idempotency_key: `pos-cash-${order.id}-${tendered}` }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(await readError(response, "The cash could not be recorded."));
      const body = await response.json().catch(() => ({})) as { result?: { change_cents?: number } };
      if (!shiftId) void onDrawerChanged();
      onPaid({ order, method: "cash", changeCents: Number(body.result?.change_cents ?? change), tenderedCents: tendered });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "The cash could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  // One screen, no scrolling (owner, 2026-10-19): what was handed over and the
  // change on the left, the keypad and Record cash on the right.
  return <div className="mt-2 grid gap-3 md:grid-cols-[1fr_22rem] lg:grid-cols-[1fr_26rem]">
    <div className="grid content-start gap-2">
      <div className="rounded-2xl border-2 border-wayne-border px-4 py-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3"><p className="text-sm font-bold">Cash received</p><p aria-live="polite" className="text-4xl font-black tabular-nums">{formatCents(tendered)}</p></div>
        <p aria-live="polite" className={`mt-1 text-3xl font-black ${change === null ? "text-wayne-red" : "text-wayne-ok"}`}>{change === null ? (tendered ? `Still owed ${formatCents(due - tendered)}` : "Enter the cash handed over") : `Change ${formatCents(change)}`}</p>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {quickCashAmounts(due).map((amount) => <Button className="min-h-14 text-xl" key={amount} onClick={() => { onError(""); setDigits(String(amount)); }} variant="secondary">{amount === due ? "Exact" : formatCents(amount)}</Button>)}
      </div>
    </div>
    <div className="grid content-start gap-1.5">
      <div className="grid grid-cols-3 gap-1.5">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "back"].map((key) => <button aria-label={key === "back" ? "Delete last digit" : key} className="min-h-12 rounded-xl border border-wayne-border bg-white text-2xl font-black shadow-sm active:translate-y-px" key={key} onClick={() => press(key)} type="button">{key === "back" ? "⌫" : key}</button>)}
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-1.5">
        <Button className="min-h-14" onClick={() => press("clear")} variant="ghost">Clear</Button>
        <Button className="min-h-14 text-lg" disabled={busy || change === null} onClick={() => { void record(); }}>{busy ? "Saving…" : change === null ? "Record cash" : `Record cash · change ${formatCents(change)}`}</Button>
      </div>
    </div>
  </div>;
}

function CardTender({ order, terminals, busy, setBusy, onError, onPaid, stripeReader, autoStart = false }: TenderProps & { terminals: Terminal[]; stripeReader: boolean; autoStart?: boolean }) {
  const [pickedTerminalId, setTerminalId] = useState(terminals[0]?.id ?? "");
  const terminalId = pickedTerminalId || terminals[0]?.id || "";
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

  // A single linked reader (no Stripe M2): send it the total without waiting for a tap.
  const autoSent = useRef(false);
  useEffect(() => {
    if (!autoStart || stripeReader || autoSent.current || terminals.length !== 1 || !terminalId) return;
    autoSent.current = true;
    void sendToReader();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, stripeReader, terminals.length, terminalId]);

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
    {/* Only a delivery card is held for the driver's slip; in the store it is charged for order + tip and the order closes (owner, 2026-10-13). */}
    {stripeReader ? <StripeReaderTender autoStart={autoStart} busy={busy} onError={onError} onPaid={() => onPaid({ order, method: "card", changeCents: 0, tenderedCents: null, held: order.fulfillment_type === "delivery" })} orderId={order.id} setBusy={setBusy} totalCents={order.total_cents} /> : null}
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
  // A delivery card is approved for the order and held; the tip on the slip the
  // driver brings back is added in Deliveries at the cash-out and the card is
  // charged once then (owner, 2026-10-11).  A phone pickup is charged now for
  // the order plus any tip given on the phone, and the order is closed
  // (owner, 2026-10-13: only deliveries need tips added by hand).
  const delivery = order.fulfillment_type === "delivery";
  const [baseCents, setBaseCents] = useState(order.total_cents);
  const [tipCents, setTipCents] = useState(0);
  const [tipSaved, setTipSaved] = useState(0);
  const [payable, setPayable] = useState(order);

  async function charge() {
    if (!confirmRef.current) { onError("Secure card entry is still loading."); return; }
    setBusy(true); onError(""); setMessage("Preparing Stripe payment…");
    try {
      let current = payable;
      if (tipCents !== tipSaved) {
        setMessage("Adding the tip…");
        const tipResponse = await fetch(`/api/pos/orders/${order.id}/tip`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tip_cents: tipCents }), signal: AbortSignal.timeout(12_000),
        });
        if (!tipResponse.ok) throw new Error(await readError(tipResponse, "The tip could not be added."));
        const tipped = await tipResponse.json() as { tip_cents: number; total_cents: number };
        current = { ...payable, total_cents: tipped.total_cents };
        setPayable(current); setTipSaved(tipped.tip_cents); setBaseCents(tipped.total_cents - tipped.tip_cents);
      }
      const intentResponse = await fetch("/api/pos/keyed-card/intent", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: order.id, idempotency_key: `pos-keyed-card-${order.id}-${uuid()}` }), signal: AbortSignal.timeout(15_000),
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
      if (result?.payment_status === "captured") { onPaid({ order: current, method: "card", changeCents: 0, tenderedCents: null }); return; }
      if (result?.payment_status === "authorized") { onPaid({ order: current, method: "card", changeCents: 0, tenderedCents: null, held: true }); return; }
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
    {order.paid_cents > 0 ? <p className="mt-3 rounded-xl bg-wayne-cream p-3 text-sm font-bold">The rest of the order: {formatCents(baseCents)} (no tip on this part).</p>
      : delivery ? <p className="mt-3 rounded-xl bg-wayne-cream p-3 text-sm font-bold">Delivery: the card is approved for {formatCents(baseCents)} now. The driver&apos;s tip from the signed slip is added in Deliveries, and the card is charged once — order + tip.</p>
      : <>
        <TipPicker baseCents={baseCents} disabled={busy || order.payment_status === "paid"} onChange={setTipCents} tipCents={tipCents} />
        <p className="mt-2 text-xs font-bold text-wayne-muted">The card is charged now, tip included, and the order is closed.</p>
      </>}
    <div className="mt-3"><StripeCardField config={config} onReady={onReady} onStatus={onStatus} /></div>
    {message ? <p aria-live="polite" className="mt-2 text-sm font-bold">{message}</p> : null}
    <Button className="mt-3 w-full text-xl" disabled={busy} onClick={() => { void charge(); }} size="lg">{busy ? "Processing…" : delivery ? `Approve ${formatCents(baseCents)} on the card · tip added later` : `Approve ${formatCents(baseCents + tipCents)}${tipCents ? ` (incl. ${formatCents(tipCents)} tip)` : ""} on the card`}</Button>
  </div>;
}

/** Tip asked for on the phone, before the card is charged (owner, 2026-10-11). */
function TipPicker({ baseCents, tipCents, onChange, disabled }: { baseCents: number; tipCents: number; onChange: (cents: number) => void; disabled: boolean }) {
  const [custom, setCustom] = useState("");
  const percent = (value: number) => Math.round((baseCents * value) / 100);
  const choice = (label: string, cents: number, key: string) => <button aria-pressed={tipCents === cents && !custom} className={`min-h-14 rounded-xl border-2 px-2 text-center font-black transition disabled:opacity-40 ${tipCents === cents && !custom ? "border-wayne-green bg-wayne-green text-white" : "border-wayne-border bg-white"}`} disabled={disabled} key={key} onClick={() => { setCustom(""); onChange(cents); }} type="button"><span className="block text-base">{label}</span>{cents ? <span className="block text-xs font-bold opacity-80">{formatCents(cents)}</span> : null}</button>;
  return <div className="mt-3">
    <p className="text-sm font-black">Tip? <span className="font-bold text-wayne-muted">Ask on the phone — it&apos;s charged with the order.</span></p>
    <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
      {choice("No tip", 0, "none")}
      {choice("15%", percent(15), "15")}
      {choice("18%", percent(18), "18")}
      {choice("20%", percent(20), "20")}
      <label className={`flex min-h-14 items-center gap-1 rounded-xl border-2 px-2 ${custom ? "border-wayne-green" : "border-wayne-border"}`}>
        <span className="text-sm font-black">$</span>
        <input aria-label="Custom tip" className="w-full min-w-0 bg-transparent text-base font-black outline-none" disabled={disabled} inputMode="decimal" onChange={(event) => {
          const raw = event.target.value.replace(/[^0-9.]/g, "");
          setCustom(raw);
          const cents = Math.round(Number(raw || "0") * 100);
          if (Number.isFinite(cents)) onChange(Math.max(0, Math.min(cents, 100_000)));
        }} placeholder="Other" value={custom} />
      </label>
    </div>
  </div>;
}

/**
 * A test order's card (owner, 2026-10-11): the same steps as a real card — the
 * reader, a card keyed in over the phone, a delivery card approved now and
 * charged with the tip at cash-out — but simulated, so nothing is charged.
 */
function TestCardTender({ order, entry, busy, setBusy, onError, onPaid, autoStart = false }: TenderProps & { entry: "card_reader" | "test_keyed"; autoStart?: boolean }) {
  const delivery = order.fulfillment_type === "delivery" && entry === "test_keyed";
  // No tip on what is still owed after items were added to a paid order.
  const askTip = entry === "test_keyed" && !delivery && order.paid_cents === 0;
  const [baseCents, setBaseCents] = useState(order.total_cents);
  const [tipCents, setTipCents] = useState(0);
  const [tipSaved, setTipSaved] = useState(0);
  const [payable, setPayable] = useState(order);

  async function approve() {
    setBusy(true); onError("");
    try {
      let current = payable;
      if (askTip && tipCents !== tipSaved) {
        const tipResponse = await fetch(`/api/pos/orders/${order.id}/tip`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tip_cents: tipCents }), signal: AbortSignal.timeout(12_000),
        });
        if (!tipResponse.ok) throw new Error(await readError(tipResponse, "The tip could not be added."));
        const tipped = await tipResponse.json() as { tip_cents: number; total_cents: number };
        current = { ...payable, total_cents: tipped.total_cents };
        setPayable(current); setTipSaved(tipped.tip_cents); setBaseCents(tipped.total_cents - tipped.tip_cents);
      }
      const response = await fetch("/api/pos/test-payment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        // Like a real card: a delivery is approved and held for the driver's slip; anything else is charged now (owner, 2026-10-13).
        body: JSON.stringify({ order_id: order.id, entry, authorize_only: order.fulfillment_type === "delivery", idempotency_key: `pos-test-card-${order.id}-${uuid()}` }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(await readError(response, "The test payment could not be recorded."));
      const result = await response.json().catch(() => null) as { payment_status?: string } | null;
      onPaid({ order: current, method: "card", changeCents: 0, tenderedCents: null, held: result?.payment_status === "authorized" });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "The test payment could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  // Like the real reader, the test reader starts on its own: the "customer taps" after a few seconds.
  const simulated = entry === "card_reader" && autoStart;
  const [tapIn, setTapIn] = useState<number | null>(simulated ? 4 : null);
  useEffect(() => {
    if (tapIn === null) return;
    const timer = window.setTimeout(() => {
      if (tapIn <= 1) { setTapIn(null); void approve(); return; }
      setTapIn((value) => (value === null ? null : value - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tapIn]);

  return <div className="mt-5 rounded-2xl border-2 border-dashed border-wayne-gold p-4">
    <h2 className="text-xl font-black">🧪 {entry === "card_reader" ? "Test card reader" : "Test card — keyed in"}</h2>
    {tapIn !== null ? <div aria-live="polite" className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-wayne-green p-4 text-white">
      <p className="text-2xl font-black">Waiting for the customer to tap… ({tapIn})</p>
      <Button onClick={() => setTapIn(null)} variant="secondary">Stop</Button>
    </div> : null}
    <p className="mt-1 text-sm text-wayne-muted">{entry === "card_reader"
      ? `Pretend the customer tapped their card. ${order.fulfillment_type === "delivery" ? "A delivery card is approved and held for the driver's slip" : "It's charged with the tip from the customer screen and the order closes"}, like a real card. Card sales don't open the cash drawer.`
      : delivery ? "Delivery: the test card is approved for the order now; add the tip in Deliveries at the driver's cash-out, like a real one."
      : "Pretend the card number was typed in."}</p>
    {askTip ? <TipPicker baseCents={baseCents} disabled={busy} onChange={setTipCents} tipCents={tipCents} /> : null}
    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
      <Button className="text-xl" disabled={busy} onClick={() => { void approve(); }} size="lg">{busy ? "Processing…" : delivery ? `Approve test card · ${formatCents(baseCents)}` : `Test card approved · ${formatCents(baseCents + (askTip ? tipCents : 0))}`}</Button>
      <Button disabled={busy} onClick={() => onError("Test decline — the card was declined. Try another card.")} size="lg" variant="secondary">Simulate decline</Button>
    </div>
  </div>;
}
