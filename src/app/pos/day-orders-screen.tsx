"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { fetchPrintDocument } from "@/hardware/printers/provider";
import { formatCents } from "@/lib/menu/schemas";
import { dayOrdersSchema, matchesSearch, orderStatusLabels, paymentSummary, type DayOrder } from "@/lib/orders/day-orders";
import { ticketNumber } from "@/lib/orders/ticket-number";
import type { PrintDocument } from "@/lib/printing/document";
import { requestReceipt } from "@/lib/printing/request-receipt";
import { getHardwareRuntime } from "@/stores/hardware-store";

type Filter = "all" | "open" | "closed" | "unpaid" | "pickup" | "delivery";
const filters: [Filter, string][] = [["all", "All"], ["open", "Open"], ["closed", "Closed"], ["unpaid", "Not paid"], ["pickup", "Pickup"], ["delivery", "Delivery"]];

const isPaid = (order: DayOrder) => order.payment_status === "paid" || order.payment_status === "authorized";
/**
 * Closed (owner, 2026-10-13: "close out orders once they are paid"): paid, or
 * cancelled, or done.  A paid delivery stays open until it has been delivered.
 */
function isClosed(order: DayOrder) {
  if (order.status === "cancelled" || order.status === "completed") return true;
  if (!isPaid(order)) return false;
  return order.fulfillment_type !== "delivery";
}
function stateLabel(order: DayOrder) {
  if (order.status === "cancelled") return "Cancelled";
  if (isClosed(order)) return isPaid(order) || order.payment_status === "refunded" ? "Closed" : orderStatusLabels[order.status] ?? order.status;
  return orderStatusLabels[order.status] ?? order.status;
}

function phone(value: string) {
  const digits = value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : value;
}

function shiftDay(day: string, by: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
}

/**
 * Today's orders — the order recall (owner, 2026-10-12 / 2026-10-13): every
 * order of the day, open or closed, on the whole screen.  Pull one up when a
 * customer comes back or calls: who ordered, paid or not and how, the items,
 * reprint the slips, take the payment, or add items they want on top.
 */
export function DayOrdersScreen({ timeZone, onPay, onAddItems }: { timeZone: string; onPay?: (orderId: string) => void; onAddItems?: (order: DayOrder) => void }) {
  const [day, setDay] = useState<string | null>(null);
  const [today, setToday] = useState("");
  const [orders, setOrders] = useState<DayOrder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/pos/day-orders${day ? `?day=${day}` : ""}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const body: unknown = await response.json().catch(() => null);
      const parsed = dayOrdersSchema.safeParse(body);
      if (!response.ok || !parsed.success) throw new Error(body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "Orders are unavailable.");
      if (!mounted.current) return;
      setOrders(parsed.data.orders); setError(""); setLoaded(true);
      if (!day) setToday(parsed.data.day);
    } catch (cause) {
      if (mounted.current) { setError(cause instanceof Error ? cause.message : "Orders are unavailable."); setLoaded(true); }
    }
  }, [day]);

  useEffect(() => {
    mounted.current = true;
    const first = window.setTimeout(() => { void load(); }, 0);
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => { mounted.current = false; window.clearTimeout(first); window.clearInterval(timer); };
  }, [load]);

  const shownDay = day ?? today;
  const time = (value: string | null) => value ? new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value)) : "";
  const dayLabel = shownDay ? new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(new Date(`${shownDay}T12:00:00Z`)) : "Today";

  // Add-ons are shown inside the order they belong to, not as orders of their own.
  const addOns = (parentId: string) => orders.filter((order) => order.parent_order_id === parentId);
  const mainOrders = orders.filter((order) => !order.parent_order_id || !orders.some((candidate) => candidate.id === order.parent_order_id));
  const visible = mainOrders.filter((order) => (matchesSearch(order, query) || addOns(order.id).some((addOn) => matchesSearch(addOn, query))) && (
    filter === "all" ? true
      : filter === "unpaid" ? (!isPaid(order) || addOns(order.id).some((addOn) => !isPaid(addOn) && addOn.status !== "cancelled")) && order.status !== "cancelled"
      : filter === "pickup" || filter === "delivery" ? order.fulfillment_type === filter
      : filter === "open" ? !isClosed(order) || addOns(order.id).some((addOn) => !isClosed(addOn))
      : isClosed(order) && addOns(order.id).every(isClosed)));
  const selected = orders.find((order) => order.id === selectedId) ?? null;
  const counted = orders.filter((order) => order.status !== "cancelled" && !order.is_test);
  // Tips are paid out, not store income (owner, 2026-10-13).
  const sales = counted.reduce((sum, order) => sum + order.total_cents - order.tip_cents, 0);
  const tips = counted.reduce((sum, order) => sum + order.tip_cents, 0);
  const unpaid = counted.filter((order) => !isPaid(order)).length;
  const openCount = mainOrders.filter((order) => !isClosed(order)).length;

  return <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:flex-row lg:overflow-hidden">
    <section aria-label="Orders" className={`flex min-h-[calc(100vh-11rem)] flex-1 flex-col rounded-2xl bg-white p-3 shadow-sm lg:min-h-0 lg:basis-1/2 ${selected ? "hidden lg:flex" : "flex"}`}>
      <div className="flex items-center justify-between gap-2">
        <Button aria-label="Previous day" onClick={() => { setSelectedId(null); setDay(shiftDay(shownDay, -1)); }} size="lg" variant="secondary" disabled={!shownDay}>‹</Button>
        <div className="min-w-0 text-center">
          <h1 className="text-2xl font-black leading-tight">{day && day !== today ? dayLabel : `Today · ${dayLabel}`}</h1>
          <p className="text-sm font-bold text-wayne-muted">{counted.length} order{counted.length === 1 ? "" : "s"} · {formatCents(sales)} sales{tips ? ` · ${formatCents(tips)} tips` : ""}{openCount ? ` · ${openCount} open` : ""}{unpaid ? ` · ${unpaid} not paid` : ""}</p>
        </div>
        <Button aria-label="Next day" disabled={!day || day >= today} onClick={() => { setSelectedId(null); const next = shiftDay(shownDay, 1); setDay(next >= today ? null : next); }} size="lg" variant="secondary">›</Button>
      </div>
      <input aria-label="Search orders" className="mt-3 min-h-12 rounded-xl border border-wayne-border px-3 text-lg" onChange={(event) => setQuery(event.target.value)} placeholder="Search #, name or phone" value={query} />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {filters.map(([value, label]) => <button aria-pressed={filter === value} className={`min-h-11 rounded-full px-4 text-base font-bold ${filter === value ? "bg-wayne-green text-white" : "bg-wayne-cream text-wayne-ink"}`} key={value} onClick={() => setFilter(value)} type="button">{label}</button>)}
      </div>
      {error ? <p className="mt-2 rounded-xl bg-wayne-alert-soft p-2 text-sm font-bold text-wayne-alert" role="alert">{error}</p> : null}
      <ul className="mt-3 grid content-start gap-2 pr-1 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {visible.map((order) => {
          const paid = isPaid(order);
          const extras = addOns(order.id).filter((addOn) => addOn.status !== "cancelled");
          const extrasDue = extras.some((addOn) => !isPaid(addOn));
          const total = order.total_cents + extras.reduce((sum, addOn) => sum + addOn.total_cents, 0);
          const closed = isClosed(order) && !extras.some((addOn) => !isClosed(addOn));
          return <li key={order.id}>
            <button aria-current={order.id === selectedId ? "true" : undefined} className={`flex min-h-20 w-full items-center gap-3 rounded-2xl border-2 p-3 text-left transition active:scale-[0.99] ${order.id === selectedId ? "border-wayne-green bg-wayne-ok-soft" : "border-wayne-border bg-white hover:border-wayne-border-strong"} ${order.status === "cancelled" ? "opacity-60" : ""}`} onClick={() => setSelectedId(order.id)} type="button">
              <span className={`grid h-14 min-w-14 shrink-0 place-items-center rounded-xl px-2 text-2xl font-black ${closed ? "bg-wayne-cream text-wayne-muted" : "bg-wayne-green text-white"}`}>#{ticketNumber(order)}</span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-xl">{order.customer_name || "Walk-in"}</strong>
                <span className="block truncate text-base text-wayne-muted">{time(order.placed_at)} · {order.fulfillment_type === "delivery" ? "Delivery" : "Pickup"} · {order.source === "online" ? "Online" : order.source === "phone" ? "Phone" : "Counter"} · {stateLabel(order)}{extras.length ? ` · +${extras.length} add-on${extras.length === 1 ? "" : "s"}` : ""}{order.is_test ? " · TEST" : ""}</span>
              </span>
              <span className="shrink-0 text-right">
                <strong className="block text-2xl tabular-nums">{formatCents(total)}</strong>
                <span className={`text-sm font-black uppercase ${order.status === "cancelled" ? "text-wayne-muted" : paid && !extrasDue ? "text-wayne-ok" : "text-wayne-red"}`}>{order.status === "cancelled" ? "Cancelled" : paid && !extrasDue ? "Paid" : paid ? "Add-on due" : "Not paid"}</span>
              </span>
            </button>
          </li>;
        })}
        {loaded && !visible.length && !error ? <li className="rounded-xl border border-dashed border-wayne-border p-6 text-center text-lg text-wayne-muted">{orders.length ? "No orders match." : "No orders yet."}</li> : null}
      </ul>
    </section>

    <section aria-label="Order details" className={`flex-1 rounded-2xl bg-white p-4 shadow-sm lg:min-h-0 lg:basis-1/2 lg:overflow-y-auto ${selected ? "block" : "hidden lg:block"}`}>
      {selected ? <>
        <Button className="mb-3 lg:hidden" onClick={() => setSelectedId(null)} size="lg" variant="secondary">‹ All orders</Button>
        <OrderDetail addOns={addOns(selected.id)} key={selected.id} onAddItems={onAddItems} onPay={onPay} onSelect={setSelectedId} order={selected} time={time} />
      </> : <div className="grid h-full place-items-center p-8 text-center text-wayne-muted"><p className="text-lg font-bold">Choose an order to see who ordered, how it was paid, and the items — or add items to it.</p></div>}
    </section>
  </div>;
}

function OrderDetail({ order, addOns, time, onPay, onAddItems, onSelect }: { order: DayOrder; addOns: DayOrder[]; time: (value: string | null) => string; onPay?: (orderId: string) => void; onAddItems?: (order: DayOrder) => void; onSelect: (orderId: string) => void }) {
  const [doc, setDoc] = useState<PrintDocument | null>(null);
  const [itemsError, setItemsError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchPrintDocument(order.id)
      .then((loaded) => { if (alive) setDoc(loaded); })
      .catch(() => { if (alive) setItemsError("The items could not be loaded."); });
    return () => { alive = false; };
  }, [order.id]);

  const paid = isPaid(order);
  const unpaidOpen = !paid && order.status !== "cancelled";
  // Add items: anything not cancelled or refunded (an add-on adds to the order it belongs to).
  const canAdd = Boolean(onAddItems) && !["cancelled", "payment_pending", "draft"].includes(order.status) && !["refunded", "partially_refunded"].includes(order.payment_status);
  const liveAddOns = addOns.filter((addOn) => addOn.status !== "cancelled");
  const address = order.delivery_address;
  const times = ([
    ["Placed", order.placed_at], ["Promised", order.promised_at], ["Ready", order.ready_at],
    ["Out for delivery", order.out_for_delivery_at], ["Done", order.completed_at], ["Cancelled", order.cancelled_at],
    ["Paid", order.paid_at],
  ] as const).filter(([, value]) => value);

  async function printReceipt() {
    setBusy(true); setNote("Printing…");
    setNote((await requestReceipt(order.id)).message);
    setBusy(false);
  }
  async function printKitchen() {
    const runtime = getHardwareRuntime();
    if (!runtime) { setNote("Printing is still starting up. Try again in a moment."); return; }
    setBusy(true); setNote("Printing…");
    const result = await runtime.kitchenPrinter.printKitchenTicket(order.id);
    setNote(result.ok ? "Kitchen ticket sent to the printer." : result.reason);
    setBusy(false);
  }

  const row = (label: string, value: string) => <div className="flex justify-between gap-4 py-0.5"><span className="text-wayne-muted">{label}</span><span className="tabular-nums">{value}</span></div>;

  return <div>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted"><span className="mr-1 rounded-lg bg-wayne-green px-2 py-0.5 text-lg tracking-normal text-white">#{ticketNumber(order)}{order.parent_order_id ? " add-on" : ""}</span> {order.order_number} · {order.fulfillment_type === "delivery" ? "Delivery" : "Pickup"} · {order.source === "online" ? "Online" : order.source === "phone" ? `Phone${order.phone_line ? ` line ${order.phone_line}` : ""}` : "Counter"}{order.is_test ? " · TEST" : ""}</p>
        <h2 className="mt-1 text-3xl font-black">{order.customer_name || "Walk-in"}</h2>
        {order.customer_phone ? <a className="mt-1 inline-block text-xl font-bold text-wayne-green underline" href={`tel:${order.customer_phone}`}>{phone(order.customer_phone)}</a> : <p className="mt-1 text-wayne-muted">No phone number</p>}
      </div>
      <div className="text-right">
        <span className="inline-block rounded-full bg-wayne-cream px-3 py-1 text-sm font-black">{stateLabel(order)}</span>
        <p className="mt-1 text-4xl font-black">{formatCents(order.total_cents)}</p>
      </div>
    </div>

    <div className={`mt-4 rounded-2xl p-4 ${order.status === "cancelled" ? "bg-wayne-cream" : paid ? "bg-wayne-ok-soft" : "bg-wayne-alert-soft"}`}>
      <p className={`text-2xl font-black ${order.status === "cancelled" ? "" : paid ? "text-wayne-ok" : "text-wayne-alert"}`}>{paymentSummary(order)}</p>
      {order.paid_method === "cash" && order.tendered_cents !== null ? <p className="mt-1 font-bold">Handed {formatCents(order.tendered_cents)} · change {formatCents(order.change_cents ?? 0)}</p> : null}
      {order.paid_at ? <p className="mt-1 text-sm">at {time(order.paid_at)}</p> : null}
    </div>

    {address && order.fulfillment_type === "delivery" ? <div className="mt-4 rounded-2xl border border-wayne-border p-4">
      <p className="text-sm font-black uppercase tracking-[0.14em] text-wayne-muted">Deliver to</p>
      <p className="mt-1 text-lg font-bold">{address.address1}{address.address2 ? `, ${address.address2}` : ""}</p>
      <p>{[address.city, address.state, address.postal_code].filter(Boolean).join(", ")}</p>
      {address.delivery_instructions ? <p className="mt-1 font-bold">Driver: {address.delivery_instructions}</p> : null}
    </div> : null}

    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <div className="rounded-2xl border border-wayne-border p-4">
        <p className="text-sm font-black uppercase tracking-[0.14em] text-wayne-muted">Items ({order.item_count})</p>
        {doc ? <ul className="mt-2 grid gap-2">{doc.items.map((item) => <li key={item.id}>
          <div className="flex justify-between gap-3 font-bold"><span>{item.quantity}× {item.variant ? `${item.variant} ` : ""}{item.name}</span><span className="tabular-nums">{formatCents(item.line_total_cents)}</span></div>
          {item.modifiers.length ? <p className="text-sm text-wayne-muted">{item.modifiers.map((modifier) => `${modifier.name}${modifier.quantity > 1 ? ` ×${modifier.quantity}` : ""}`).join(", ")}</p> : null}
          {item.instructions ? <p className="text-sm font-bold">Note: {item.instructions}</p> : null}
        </li>)}</ul> : <p className="mt-2 text-sm text-wayne-muted">{itemsError || "Loading items…"}</p>}
        {order.special_instructions ? <p className="mt-3 rounded-xl bg-wayne-cream p-2 text-sm font-bold">Order note: {order.special_instructions}</p> : null}
        <div className="mt-3 border-t border-wayne-border pt-2 text-sm">
          {row("Subtotal", formatCents(order.subtotal_cents))}
          {order.discount_cents ? row("Discount", formatCents(-order.discount_cents)) : null}
          {order.delivery_fee_cents ? row("Delivery", formatCents(order.delivery_fee_cents)) : null}
          {row("Tax", formatCents(order.tax_cents))}
          {order.tip_cents ? row("Tip", formatCents(order.tip_cents)) : null}
          <div className="flex justify-between gap-4 pt-1 text-lg font-black"><span>Total</span><span className="tabular-nums">{formatCents(order.total_cents)}</span></div>
        </div>
      </div>
      <div className="rounded-2xl border border-wayne-border p-4">
        <p className="text-sm font-black uppercase tracking-[0.14em] text-wayne-muted">Times</p>
        <div className="mt-2 text-base">{times.map(([label, value]) => row(label, time(value)))}</div>
        {order.taken_by ? <p className="mt-3 text-sm text-wayne-muted">Taken by <strong className="text-wayne-ink">{order.taken_by}</strong></p> : null}
      </div>
    </div>

    {liveAddOns.length ? <div className="mt-4 rounded-2xl border-2 border-wayne-gold p-4">
      <p className="text-sm font-black uppercase tracking-[0.14em] text-wayne-muted">Added after it was paid</p>
      <ul className="mt-2 grid gap-2">{liveAddOns.map((addOn) => <li key={addOn.id}>
        <button className="flex w-full items-center justify-between gap-3 rounded-xl bg-wayne-cream p-3 text-left" onClick={() => onSelect(addOn.id)} type="button">
          <span><strong>Add-on · {addOn.item_count} item{addOn.item_count === 1 ? "" : "s"}</strong><span className="block text-sm text-wayne-muted">{time(addOn.placed_at)} · {addOn.order_number}</span></span>
          <span className="text-right"><strong className="block text-xl">{formatCents(addOn.total_cents)}</strong><span className={`text-xs font-black uppercase ${isPaid(addOn) ? "text-wayne-ok" : "text-wayne-red"}`}>{isPaid(addOn) ? "Paid" : "Not paid"}</span></span>
        </button>
        {!isPaid(addOn) && onPay ? <Button className="mt-1 w-full" onClick={() => onPay(addOn.id)} variant="brand">Take payment for the add-on · {formatCents(addOn.total_cents)}</Button> : null}
      </li>)}</ul>
      <p className="mt-2 text-right text-lg font-black">Order + add-ons {formatCents(order.total_cents + liveAddOns.reduce((sum, addOn) => sum + addOn.total_cents, 0))}</p>
    </div> : null}

    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      {canAdd ? <Button className="min-h-16 text-xl sm:col-span-2" onClick={() => onAddItems?.(order)} size="lg">＋ Add items{paid ? " (paid separately)" : ""}</Button> : null}
      {unpaidOpen && onPay ? <Button className="sm:col-span-2" onClick={() => onPay(order.id)} size="lg" variant="brand">Take payment · {formatCents(order.total_cents)}</Button> : null}
      <Button disabled={busy} onClick={() => { void printReceipt(); }} size="lg" variant="secondary">Print receipt</Button>
      <Button disabled={busy} onClick={() => { void printKitchen(); }} size="lg" variant="secondary">Print kitchen ticket</Button>
    </div>
    {note ? <p aria-live="polite" className="mt-2 font-bold">{note}</p> : null}
  </div>;
}
