"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatCents } from "@/lib/menu/schemas";
import { draftLabel } from "@/lib/orders/drafts";
import { openOrderSchema, type OpenOrder } from "@/lib/orders/status";
import { orderActions, useDrafts } from "@/stores/order-store";

/**
 * Current orders, always beside the menu (owner, 2026-10-13: "there should
 * be a panel on the side where it shows all of the current orders").
 *
 *   • tickets on hold on this register — tap to pick it back up
 *   • every open order sent today (register, phone and online), newest
 *     first, with how long ago, paid or not, and the total — tap an unpaid
 *     one to take its payment, a paid one to open the Orders list
 *
 * It can be folded away to a thin strip; each register remembers that.
 */
const FOLD_KEY = "wayne.pos.ordersRail";
const statusLabels: Record<string, string> = { placed: "New", accepted: "Accepted", in_kitchen: "Cooking", ready: "Ready", out_for_delivery: "Out" };

function minutesAgo(iso: string, now: number) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function CurrentOrdersRail({ canSeeOrders, onPay, onOpenOrders }: { canSeeOrders: boolean; onPay: (orderId: string) => void; onOpenOrders: () => void }) {
  const { drafts } = useDrafts();
  const held = drafts.filter((draft) => draft.held);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [error, setError] = useState("");
  const [folded, setFolded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  useEffect(() => {
    const timer = window.setTimeout(() => { try { setFolded(window.localStorage.getItem(FOLD_KEY) === "folded"); } catch { /* default open */ } }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function fold(value: boolean) {
    setFolded(value);
    try { window.localStorage.setItem(FOLD_KEY, value ? "folded" : "open"); } catch { /* this visit only */ }
  }

  const load = useCallback(async () => {
    if (!canSeeOrders) return;
    try {
      const response = await fetch("/api/pos/open-orders", { cache: "no-store", signal: AbortSignal.timeout(8000) });
      const body: unknown = await response.json();
      const parsed = openOrderSchema.array().safeParse(body);
      if (!response.ok || !parsed.success) throw new Error("Orders are unavailable — retrying.");
      if (mounted.current) { setOrders(parsed.data); setError(""); setNow(Date.now()); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Orders are unavailable — retrying.");
    }
  }, [canSeeOrders]);

  useEffect(() => {
    mounted.current = true;
    const first = window.setTimeout(() => { void load(); }, 0);
    const timer = window.setInterval(() => { void load(); }, 8_000);
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => { mounted.current = false; window.clearTimeout(first); window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [load]);

  const sorted = [...orders].sort((a, b) => Date.parse(b.placed_at) - Date.parse(a.placed_at));
  const count = sorted.length + held.length;

  if (folded) {
    return <button aria-label={`Show current orders (${count})`} className="hidden w-12 shrink-0 flex-col items-center gap-2 border-r border-wayne-border bg-white py-3 text-wayne-ink lg:flex" onClick={() => fold(false)} type="button">
      <span aria-hidden className="text-xl">»</span>
      <span className="rounded-full bg-wayne-green px-2 py-0.5 text-sm font-black text-white">{count}</span>
      <span className="text-xs font-black uppercase tracking-wider [writing-mode:vertical-rl]">Orders</span>
    </button>;
  }

  return <aside aria-label="Current orders" className="hidden w-60 shrink-0 flex-col border-r border-wayne-border bg-white lg:flex 2xl:w-72">
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-wayne-border px-3 py-2">
      <h2 className="text-base font-black">Current orders <span className="text-wayne-muted">({count})</span></h2>
      <button aria-label="Hide current orders" className="min-h-10 min-w-10 rounded-lg text-xl font-black hover:bg-wayne-cream" onClick={() => fold(true)} type="button">«</button>
    </div>
    <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
      {held.length ? <p className="px-1 pt-1 text-[0.65rem] font-black uppercase tracking-[0.14em] text-wayne-muted">On hold here</p> : null}
      {held.map((draft) => <button className="w-full rounded-xl border-2 border-dashed border-wayne-border-strong bg-wayne-cream p-2 text-left active:scale-[0.98]" key={draft.id} onClick={() => orderActions.resume(draft.id)} type="button">
        <span className="block truncate text-sm font-black">⏸ {draftLabel(draft)}</span>
        <span className="block text-xs font-bold text-wayne-muted">{draft.cart.length} item{draft.cart.length === 1 ? "" : "s"}{draft.submitPending ? " · sending…" : " · tap to continue"}</span>
      </button>)}
      {canSeeOrders ? <>
        {sorted.length ? <p className="px-1 pt-1 text-[0.65rem] font-black uppercase tracking-[0.14em] text-wayne-muted">Sent</p> : null}
        {sorted.map((order) => {
          const paid = order.payment_status === "paid";
          const cardOnFile = order.payment_status === "authorized";
          return <button className={`w-full rounded-xl border p-2 text-left active:scale-[0.98] ${order.status === "ready" ? "border-wayne-ok bg-wayne-ok-soft" : "border-wayne-border bg-white"}`} key={order.id} onClick={() => (paid || cardOnFile ? onOpenOrders() : onPay(order.id))} type="button">
            <span className="flex items-baseline justify-between gap-2">
              <strong className="truncate text-sm">{order.fulfillment_type === "delivery" ? "🚗" : "🛍️"} {order.customer_name || "Customer"}</strong>
              <span className="shrink-0 text-xs font-bold text-wayne-muted">{minutesAgo(order.placed_at, now)}</span>
            </span>
            <span className="mt-0.5 flex items-center justify-between gap-2 text-xs font-bold">
              <span className="truncate text-wayne-muted">#{order.order_number.replace(/^W0*/, "")} · {order.source === "online" ? "Online" : order.source === "phone" ? "Phone" : "Counter"} · {statusLabels[order.status] ?? order.status}{order.is_test ? " · TEST" : ""}</span>
              <span className={`shrink-0 rounded px-1.5 py-0.5 ${paid ? "bg-wayne-ok-soft text-wayne-ok" : cardOnFile ? "bg-wayne-cream" : "bg-wayne-alert-soft text-wayne-alert"}`}>{formatCents(order.total_cents)} {paid ? "PAID" : cardOnFile ? "CARD" : "DUE"}</span>
            </span>
          </button>;
        })}
        {!sorted.length && !held.length && !error ? <p className="p-3 text-center text-sm text-wayne-muted">No open orders right now.</p> : null}
        {error ? <p className="rounded-lg bg-wayne-warn-soft p-2 text-xs font-bold">{error}</p> : null}
      </> : null}
    </div>
    {canSeeOrders ? <button className="min-h-12 shrink-0 border-t border-wayne-border text-sm font-black text-wayne-green hover:bg-wayne-cream" onClick={onOpenOrders} type="button">All orders →</button> : null}
  </aside>;
}
