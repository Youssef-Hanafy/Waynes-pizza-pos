"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  cashoutSummary, maxTipCents, paidByLabel, posCashoutResultSchema, posDeliveryBoardSchema, tipAllowed,
  type PosCashoutResult, type PosDeliveryBoard, type PosDeliveryOrder,
} from "@/lib/delivery/pos-board";
import { formatCents } from "@/lib/menu/schemas";

async function readError(response: Response, fallback: string) {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : fallback;
}

/** "3.50" → 350; blank → 0; anything else → null. */
function dollarsToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned) return 0;
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

function minutesAgo(iso: string | null | undefined) {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * Deliveries, the way the store already works in Thrive (owner, 2026-10-11):
 *
 *   Waiting to go out → tap a driver to send the order out with them.
 *   Each driver       → their run: ticket, name, address, how it was paid,
 *                        and a tip box per order.
 *   Cash out          → shows what the driver hands in, then records the cash,
 *                        charges each held card once with its tip, and pays the
 *                        driver's tips out of the drawer.
 */
export function DeliveriesScreen({ timeZone }: { timeZone: string }) {
  const [board, setBoard] = useState<PosDeliveryBoard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [tips, setTips] = useState<Record<string, string>>({});
  const [cashingOut, setCashingOut] = useState<string | null>(null);
  const [result, setResult] = useState<(PosCashoutResult & { problems: string[] }) | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/pos/delivery", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(await readError(response, "Deliveries could not be loaded."));
      const parsed = posDeliveryBoardSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Deliveries could not be read.");
      if (mounted.current) { setBoard(parsed.data); setError(""); }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Deliveries could not be loaded.");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const first = window.setTimeout(() => { void load(); }, 0);
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 10_000);
    return () => { mounted.current = false; window.clearTimeout(first); window.clearInterval(timer); };
  }, [load]);

  async function act(key: string, body: Record<string, string>) {
    setBusy(key); setError("");
    try {
      const response = await fetch("/api/pos/delivery", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(await readError(response, "That could not be saved."));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  const tipCents = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [orderId, raw] of Object.entries(tips)) out[orderId] = dollarsToCents(raw) ?? 0;
    return out;
  }, [tips]);

  async function cashOut(driverId: string, orders: PosDeliveryOrder[]) {
    const bad = orders.find((order) => tips[order.order_id] && dollarsToCents(tips[order.order_id]!) === null);
    if (bad) { setError(`Check the tip on order ${bad.order_number} (e.g. 5.00).`); return; }
    setBusy(`cashout-${driverId}`); setError("");
    try {
      const response = await fetch("/api/pos/delivery/cashout", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driver_id: driverId,
          tips: orders.filter(tipAllowed).map((order) => ({ order_id: order.order_id, tip_cents: Math.min(tipCents[order.order_id] ?? 0, maxTipCents(order)) })),
          note: "",
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "The cash-out could not be saved.");
      const parsed = posCashoutResultSchema.safeParse(body);
      const problems = body && typeof body === "object" && "problems" in body && Array.isArray((body as { problems: unknown }).problems) ? (body as { problems: string[] }).problems : [];
      if (parsed.success) setResult({ ...parsed.data, problems });
      setCashingOut(null);
      setTips((current) => {
        const next = { ...current };
        for (const order of orders) delete next[order.order_id];
        return next;
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The cash-out could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  const time = (iso: string | null | undefined) => iso ? new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "";
  const drivers = board?.drivers ?? [];
  const waiting = board?.waiting ?? [];

  return <div className="min-h-0 flex-1 overflow-y-auto bg-wayne-cream-deep p-3 sm:p-4">
    <div className="mx-auto grid max-w-7xl gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-black">Deliveries</h1>
        <Button onClick={() => { void load(); }} size="sm" variant="secondary">Refresh</Button>
      </div>
      {error ? <p className="rounded-xl bg-wayne-alert-soft p-3 font-bold text-wayne-alert" role="alert">{error}</p> : null}

      {result ? <section aria-live="polite" className="rounded-3xl border-2 border-wayne-ok bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.16em] text-wayne-ok">Cashed out · {result.driver_name}</p>
            <p className="mt-1 text-4xl font-black">{result.hand_in_cents >= 0 ? `Hands in ${formatCents(result.hand_in_cents)}` : `Pay ${result.driver_name} ${formatCents(-result.hand_in_cents)}`}</p>
            <p className="mt-1 text-sm text-wayne-muted">{result.order_count} deliveries · cash orders {formatCents(result.cash_orders_cents)} · card tips {formatCents(result.card_tips_cents)} · cash tips kept {formatCents(result.cash_tips_cents)}</p>
          </div>
          <Button onClick={() => setResult(null)} variant="secondary">Done</Button>
        </div>
        {result.problems.length ? <ul className="mt-3 list-disc rounded-xl bg-wayne-warn-soft p-3 pl-8 text-sm font-bold">{result.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
      </section> : null}

      <section className="rounded-3xl bg-white p-4 shadow-sm">
        <h2 className="text-sm font-black uppercase tracking-[0.16em] text-wayne-muted">Waiting to go out ({waiting.length})</h2>
        {!board ? <p className="mt-3 text-wayne-muted">Loading…</p> : !waiting.length ? <p className="mt-3 text-wayne-muted">No delivery orders waiting.</p> : null}
        <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {waiting.map((order) => <li className="rounded-2xl border-2 border-wayne-border p-3" key={order.order_id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-lg font-black">#{order.order_number.replace(/^W0*/, "")} · {order.customer_name || "Customer"}{order.is_test ? " · TEST" : ""}</p>
                <p className="truncate text-sm">{order.address || "No address"}{order.city ? `, ${order.city}` : ""}</p>
                <p className="text-xs font-bold text-wayne-muted">{paidByLabel(order)} · {formatCents(order.total_cents)} · placed {time(order.placed_at)} ({minutesAgo(order.placed_at)} ago)</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {drivers.length ? drivers.map((driver) => <Button disabled={busy !== null} key={driver.driver_id} onClick={() => { void act(`send-${order.order_id}`, { action: "send_out", order_id: order.order_id, driver_id: driver.driver_id }); }} size="sm">{busy === `send-${order.order_id}` ? "Sending…" : `🚗 ${driver.name}`}</Button>)
                : <p className="text-sm text-wayne-muted">No drivers set up. Give a staff member the Driver role in Admin → Staff.</p>}
            </div>
          </li>)}
        </ul>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        {drivers.map((driver) => {
          const orders = driver.orders;
          const summary = cashoutSummary(orders, tipCents);
          const out = orders.filter((order) => order.status === "out_for_delivery").length;
          const confirming = cashingOut === driver.driver_id;
          return <section className="rounded-3xl bg-white p-4 shadow-sm" key={driver.driver_id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-2xl font-black">{driver.name}</h2>
              <span className={`rounded-full px-3 py-1 text-xs font-black uppercase tracking-wider ${out ? "bg-wayne-green text-white" : "bg-wayne-cream text-wayne-muted"}`}>{out ? `Out · ${out} order${out === 1 ? "" : "s"}` : orders.length ? "Back in store" : "No deliveries"}</span>
            </div>
            {driver.last_cashout_at ? <p className="text-xs text-wayne-muted">Last cashed out {time(driver.last_cashout_at)}</p> : null}
            {orders.length ? <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <thead><tr className="border-b border-wayne-border text-xs uppercase tracking-wider text-wayne-muted"><th className="py-2 pr-2">#</th><th className="pr-2">Customer</th><th className="pr-2">Paid</th><th className="pr-2 text-right">Total</th><th className="w-28 pr-2">Tip</th><th /></tr></thead>
                <tbody>{orders.map((order) => {
                  const allowed = tipAllowed(order);
                  const raw = tips[order.order_id] ?? "";
                  const cents = dollarsToCents(raw);
                  const cap = maxTipCents(order);
                  const over = cents !== null && cents > cap;
                  const staleHold = order.paid_by === "card_held" && order.held_at && Date.now() - Date.parse(order.held_at) > 5 * 86_400_000;
                  return <tr className="border-b border-wayne-border align-top last:border-0" key={order.order_id}>
                    <td className="py-2 pr-2 font-black">{order.order_number.replace(/^W0*/, "")}</td>
                    <td className="py-2 pr-2"><strong className="block">{order.customer_name || "Customer"}{order.is_test ? " · TEST" : ""}</strong><span className="block text-xs text-wayne-muted">{order.address}{order.city ? `, ${order.city}` : ""}</span>{staleHold ? <span className="block text-xs font-bold text-wayne-alert">Card hold expires soon — cash out today</span> : null}</td>
                    <td className="py-2 pr-2 text-xs font-bold">{paidByLabel(order)}</td>
                    <td className="py-2 pr-2 text-right font-bold">{formatCents(order.total_cents)}</td>
                    <td className="py-2 pr-2">{allowed ? <>
                      <input aria-label={`Tip for order ${order.order_number}`} className={`min-h-11 w-24 rounded-lg border px-2 text-right text-base font-bold ${cents === null || over ? "border-wayne-alert" : "border-wayne-border"}`} inputMode="decimal" onChange={(event) => setTips((current) => ({ ...current, [order.order_id]: event.target.value }))} placeholder="0.00" value={raw} />
                      {over ? <span className="block text-xs font-bold text-wayne-alert">Max {formatCents(cap)} on this card</span> : null}
                    </> : <span className="text-sm font-bold">{order.tip_cents ? formatCents(order.tip_cents) : "—"}<span className="block text-xs font-normal text-wayne-muted">on the card</span></span>}</td>
                    <td className="py-2 text-right">{order.status === "out_for_delivery" ? <button className="min-h-9 text-xs font-bold underline" disabled={busy !== null} onClick={() => { void act(`back-${order.order_id}`, { action: "unassign", order_id: order.order_id }); }} type="button">Take back</button> : null}</td>
                  </tr>;
                })}</tbody>
              </table>
            </div> : <p className="mt-3 text-sm text-wayne-muted">Nothing to cash out.</p>}

            {orders.length ? confirming ? <div className="mt-4 rounded-2xl border-2 border-wayne-green bg-wayne-green/5 p-4">
              <dl className="grid grid-cols-2 gap-1 text-base">
                <dt>Cash orders</dt><dd className="text-right font-bold">{formatCents(summary.cashOrders)}</dd>
                <dt>Card tips (store pays driver)</dt><dd className="text-right font-bold">− {formatCents(summary.cardTips)}</dd>
                <dt className="text-wayne-muted">Cash tips (driver keeps)</dt><dd className="text-right text-wayne-muted">{formatCents(summary.cashTips)}</dd>
              </dl>
              <p className="mt-3 border-t border-wayne-border pt-3 text-3xl font-black">{summary.handIn >= 0 ? `${driver.name} hands in ${formatCents(summary.handIn)}` : `Pay ${driver.name} ${formatCents(-summary.handIn)}`}</p>
              {summary.cardTips ? <p className="mt-1 text-sm text-wayne-muted">Card tips were charged with the orders; the drawer pays them to the driver.</p> : null}
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
                <Button className="text-lg" disabled={busy !== null} onClick={() => { void cashOut(driver.driver_id, orders); }} size="lg">{busy === `cashout-${driver.driver_id}` ? "Cashing out…" : `Confirm cash out`}</Button>
                <Button disabled={busy !== null} onClick={() => setCashingOut(null)} size="lg" variant="secondary">Back</Button>
              </div>
            </div> : <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-wayne-border pt-3">
              <p className="text-sm"><strong>{orders.length}</strong> deliveries · cash {formatCents(summary.cashOrders)} · tips {formatCents(summary.tips)}</p>
              <Button disabled={busy !== null || orders.some((order) => { const cents = dollarsToCents(tips[order.order_id] ?? ""); return cents === null || cents > maxTipCents(order); })} onClick={() => { setCashingOut(driver.driver_id); setResult(null); }} size="lg">Cash out {driver.name}</Button>
            </div> : null}
          </section>;
        })}
      </div>
    </div>
  </div>;
}
