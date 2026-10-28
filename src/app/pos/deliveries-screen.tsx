"use client";

import { logDevice } from "@/lib/pos/device-log";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ticketNumber } from "@/lib/orders/ticket-number";
import { useVisiblePolling } from "@/components/ops/use-visible-polling";
import { Button } from "@/components/ui/button";
import {
  cashoutLines, cashoutSummary, maxTipCents, paidByLabel, posCashoutResultSchema, posDeliveryBoardSchema, tipAllowed,
  type PosCashoutResult, type PosDeliveryBoard, type PosDeliveryOrder,
} from "@/lib/delivery/pos-board";
import { formatCents } from "@/lib/menu/schemas";
import { deliveryDayReportSchema, driverTipsLayout, type DeliveryDayDriver } from "@/lib/delivery/day-report";
import { getHardwareRuntime } from "@/stores/hardware-store";
import { PinPad } from "@/components/ui/pin-pad";
import { ClockButton } from "./clock-button";
import { tipSaveState } from "@/lib/tips/drafts";
import { clearTipDrafts, loadTipDrafts, refreshTipDrafts, setTipDraft, syncTipDrafts, useTipDrafts } from "@/stores/tip-drafts";
import { TipSavedNote, TipsSavedBanner } from "./tip-saved-note";

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

/** What one order means for the driver at cash-out, in plain words. */
function rundownNote(paidBy: string, collected: number, storePays: number, keeps: number) {
  const parts: string[] = [];
  if (collected) parts.push(`collected ${formatCents(collected)} cash`);
  if (storePays) parts.push(`drawer pays tip ${formatCents(storePays)}`);
  if (keeps) parts.push(`keeps ${formatCents(keeps)} cash tip`);
  if (!parts.length) parts.push(paidBy === "cash_paid" ? "paid at the counter · no tip" : "no tip");
  return parts.join(" · ");
}

const paidByShort: Record<string, string> = { card_held: "Card", card: "Card (counter)", paid: "Online", cash_paid: "Cash (counter)", cash: "Cash at door" };

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
 *                        charges each delivery card once (order + the tip on
 *                        the signed slip), and pays the tips out of the drawer.
 */
export function DeliveriesScreen({ timeZone, storeName = "Wayne's Pizza" }: { timeZone: string; storeName?: string }) {
  const [board, setBoard] = useState<PosDeliveryBoard | null>(null);
  const [error, setError] = useState("");
  // Every message shown here goes to the device log too, so a "couldn't" on the Elo can be read back (owner, 2026-10-28).
  useEffect(() => { if (error) logDevice("pos.error_shown", error, { screen: "deliveries" }); }, [error]);
  const [busy, setBusy] = useState<string | null>(null);
  // The tip boxes are saved as they are typed (owner, 2026-10-28), so leaving Deliveries — or a call opening
  // the Phone screen, or a reload — never loses them.
  const { drafts, lastError: saveError } = useTipDrafts();
  const tips = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [orderId, draft] of Object.entries(drafts)) out[orderId] = draft.raw;
    return out;
  }, [drafts]);
  const [cashingOut, setCashingOut] = useState<string | null>(null);
  const [result, setResult] = useState<(PosCashoutResult & { problems: string[]; driver_id: string }) | null>(null);
  const mounted = useRef(true);
  // Orders ticked to go out together; the driver then types his PIN.
  const [selected, setSelected] = useState<string[]>([]);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState("");
  const [notice, setNotice] = useState("");
  const [printNote, setPrintNote] = useState("");

  /**
   * The driver's tips receipt (owner, 2026-10-19: "when closing out a shift
   * print a receipt for driver total tips for the day"): this cash-out and
   * the driver's total tips for the whole day.  Printed by itself after each
   * cash-out; "Print tips slip" prints it again.
   */
  async function printDriverTips(driverId: string, driverName: string, cashout: PosCashoutResult | null) {
    const runtime = getHardwareRuntime();
    if (!runtime) { setPrintNote("Printing is still starting up — tap Print tips slip in a moment."); return; }
    setPrintNote("Printing the tips slip…");
    let day = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
    let today: DeliveryDayDriver | null = null;
    try {
      const response = await fetch("/api/pos/delivery/day-report", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const parsed = deliveryDayReportSchema.safeParse(response.ok ? await response.json() : null);
      if (parsed.success) { day = parsed.data.day; today = parsed.data.drivers.find((driver) => driver.driver_id === driverId) ?? null; }
    } catch { /* the slip still prints this cash-out without the day's total */ }
    try {
      const result = await runtime.receiptPrinter.printLayout(driverTipsLayout({ storeName, day, driverName, cashout, today, timeZone }));
      setPrintNote(result.ok ? `Tips slip for ${driverName} sent to the receipt printer.${today ? "" : " (Today's total couldn't be loaded — reprint in a moment.)"}` : result.reason);
    } catch (cause) {
      setPrintNote(cause instanceof Error ? cause.message : "The tips slip could not be printed.");
    }
  }

  const load = useCallback(async () => {
    void refreshTipDrafts();
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
    loadTipDrafts();
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useVisiblePolling(load, 30_000);

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

  /** The driver's PIN sends the ticked orders out with him and clocks him in. */
  async function takeOutWithPin(pin: string) {
    setPinBusy(true); setPinError("");
    try {
      const response = await fetch("/api/pos/delivery", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send_out_pin", order_ids: selected, pin }), signal: AbortSignal.timeout(20_000),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "That could not be saved.");
      const result = body as { name?: string; count?: number };
      setNotice(`🚗 ${result.count ?? selected.length} order${(result.count ?? selected.length) === 1 ? "" : "s"} out with ${result.name || "the driver"}.`);
      setSelected([]); setPinOpen(false);
      await load();
    } catch (cause) {
      setPinError(cause instanceof Error ? cause.message : "That could not be saved.");
    } finally {
      setPinBusy(false);
    }
  }

  const tipCents = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [orderId, raw] of Object.entries(tips)) out[orderId] = dollarsToCents(raw) ?? 0;
    return out;
  }, [tips]);

  async function cashOut(driverId: string, orders: PosDeliveryOrder[]) {
    const bad = orders.find((order) => tips[order.order_id] && dollarsToCents(tips[order.order_id]!) === null);
    if (bad) { setError(`Check the tip on order #${ticketNumber(bad)} (e.g. 5.00).`); return; }
    setBusy(`cashout-${driverId}`); setError("");
    // Whatever was typed is saved first, so nothing is lost if the cash-out is interrupted.
    await syncTipDrafts();
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
      if (parsed.success) {
        setResult({ ...parsed.data, problems, driver_id: driverId });
        void printDriverTips(driverId, parsed.data.driver_name, parsed.data);
      }
      setCashingOut(null);
      // Only the orders actually cashed out are done; one left on the run keeps its tip in the box.
      const done = body && typeof body === "object" && "cashed_out_order_ids" in body && Array.isArray((body as { cashed_out_order_ids: unknown }).cashed_out_order_ids)
        ? (body as { cashed_out_order_ids: string[] }).cashed_out_order_ids : [];
      clearTipDrafts(done);
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
  const onShift = drivers.filter((driver) => driver.clocked_in);
  const ticked = selected.filter((id) => waiting.some((order) => order.order_id === id));

  return <div className="min-h-0 flex-1 overflow-y-auto bg-wayne-cream-deep p-3 sm:p-4">
    <div className="mx-auto grid max-w-7xl gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-black">Deliveries</h1>
        <div className="flex flex-wrap gap-2">
          <ClockButton className="min-h-11 rounded-xl border border-wayne-border bg-white px-4 text-sm font-black shadow-sm" label="⏱ Driver clock in/out" onClocked={() => { void load(); }} />
          <Button onClick={() => { void load(); }} size="sm" variant="secondary">Refresh</Button>
        </div>
      </div>
      {notice ? <p className="flex items-center justify-between gap-3 rounded-xl bg-wayne-ok-soft p-3 font-bold text-wayne-ok" role="status">{notice}<button className="min-h-9 text-sm underline" onClick={() => setNotice("")} type="button">OK</button></p> : null}
      {pinOpen ? <div aria-modal className="fixed inset-0 z-[80] grid place-items-center bg-black/50 p-4" role="dialog">
        <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
          <PinPad busy={pinBusy} error={pinError} note={`${ticked.length} order${ticked.length === 1 ? "" : "s"} will be assigned to the driver whose PIN this is.`} onCancel={() => { setPinOpen(false); setPinError(""); }} onSubmit={(pin) => void takeOutWithPin(pin)} submitLabel="Take them out" title="Driver: enter your PIN" />
        </div>
      </div> : null}
      {error ? <p className="rounded-xl bg-wayne-alert-soft p-3 font-bold text-wayne-alert" role="alert">{error}</p> : null}
      <TipsSavedBanner drafts={drafts} orderIds={drivers.flatMap((driver) => driver.orders.map((order) => order.order_id))} saveError={saveError} />

      {result ? <section aria-live="polite" className="rounded-3xl border-2 border-wayne-ok bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.16em] text-wayne-ok">Cashed out · {result.driver_name}</p>
            <p className="mt-1 text-4xl font-black">{result.hand_in_cents >= 0 ? `Hands in ${formatCents(result.hand_in_cents)}` : `Pay ${result.driver_name} ${formatCents(-result.hand_in_cents)}`}</p>
            <p className="mt-1 text-sm text-wayne-muted">{result.order_count} deliveries · cash orders {formatCents(result.cash_orders_cents)} · card tips {formatCents(result.card_tips_cents)} · cash tips kept {formatCents(result.cash_tips_cents)}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => { void printDriverTips(result.driver_id, result.driver_name, result); }} variant="secondary">🖨 Print tips slip</Button>
            <Button onClick={() => { setResult(null); setPrintNote(""); }} variant="secondary">Done</Button>
          </div>
        </div>
        {printNote ? <p aria-live="polite" className="mt-2 text-sm font-bold">{printNote}</p> : null}
        {result.detail.length ? <table className="mt-3 w-full text-left text-sm">
          <thead><tr className="border-b border-wayne-border text-xs uppercase tracking-wider text-wayne-muted"><th className="py-1 pr-2">Ticket</th><th className="pr-2">Paid</th><th className="pr-2 text-right">Order</th><th className="pr-2 text-right">Tip</th><th className="pr-4 text-right">Total</th><th>Driver</th></tr></thead>
          <tbody>{result.detail.map((line) => {
            const tipFromDrawer = line.paid_by === "card_held" || line.paid_by === "card" || line.paid_by === "paid";
            return <tr className="border-b border-wayne-border last:border-0" key={line.order_id}>
              <td className="py-1 pr-2 text-xl font-black whitespace-nowrap">#{ticketNumber(line)}</td>
              <td className="pr-2">{paidByShort[line.paid_by] ?? line.paid_by}</td>
              <td className="pr-2 text-right">{formatCents(line.total_cents - line.tip_cents)}</td>
              <td className="pr-2 text-right">{formatCents(line.tip_cents)}</td>
              <td className="pr-4 text-right font-black">{formatCents(line.total_cents)}</td>
              <td className="text-xs">{rundownNote(line.paid_by, line.cash_cents, tipFromDrawer ? line.tip_cents : 0, tipFromDrawer ? 0 : line.tip_cents)}</td>
            </tr>;
          })}</tbody>
        </table> : null}
        {result.problems.length ? <ul className="mt-3 list-disc rounded-xl bg-wayne-warn-soft p-3 pl-8 text-sm font-bold">{result.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
      </section> : null}

      <section className="rounded-3xl bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-black uppercase tracking-[0.16em] text-wayne-muted">Waiting to go out ({waiting.length})</h2>
          {waiting.length ? <div className="flex flex-wrap gap-2">
            {ticked.length ? <Button onClick={() => setSelected([])} size="sm" variant="ghost">Clear</Button> : <Button onClick={() => setSelected(waiting.map((order) => order.order_id))} size="sm" variant="ghost">Select all</Button>}
            <Button disabled={!ticked.length || busy !== null} onClick={() => { setPinError(""); setPinOpen(true); }} size="sm" variant="brand">🚗 Take {ticked.length || ""} out — driver PIN</Button>
          </div> : null}
        </div>
        {!board ? <p className="mt-3 text-wayne-muted">Loading…</p> : !waiting.length ? <p className="mt-3 text-wayne-muted">No delivery orders waiting.</p> : null}
        <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {waiting.map((order) => { const isTicked = ticked.includes(order.order_id); return <li className={`rounded-2xl border-2 p-3 ${isTicked ? "border-wayne-green bg-wayne-green/5" : "border-wayne-border"}`} key={order.order_id}>
            <div className="flex items-start gap-3">
              <input aria-label={`Select order #${ticketNumber(order)}`} checked={isTicked} className="mt-1 h-7 w-7 shrink-0 accent-wayne-green" onChange={() => setSelected((current) => current.includes(order.order_id) ? current.filter((id) => id !== order.order_id) : [...current, order.order_id])} type="checkbox" />
              <div className="min-w-0">
                <p className="text-lg font-black">#{ticketNumber(order)} · {order.customer_name || "Customer"}{order.is_test ? " · TEST" : ""}</p>
                <p className="truncate text-sm">{order.address || "No address"}{order.city ? `, ${order.city}` : ""}</p>
                <p className="text-xs font-bold text-wayne-muted">{paidByLabel(order)} · {formatCents(order.total_cents)} · placed {time(order.placed_at)} ({minutesAgo(order.placed_at)} ago)</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {onShift.length ? onShift.map((driver) => <Button disabled={busy !== null} key={driver.driver_id} onClick={() => { void act(`send-${order.order_id}`, { action: "send_out", order_id: order.order_id, driver_id: driver.driver_id }); }} size="sm">{busy === `send-${order.order_id}` ? "Sending…" : `🚗 ${driver.name}`}</Button>)
                : <p className="text-sm text-wayne-muted">No driver clocked in. Tick the orders and press “Take out — driver PIN”, or clock a driver in.</p>}
            </div>
          </li>; })}
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
              <h2 className="text-2xl font-black">{driver.name}{driver.clocked_in ? "" : <span className="ml-2 align-middle text-xs font-bold uppercase tracking-wider text-wayne-muted">clocked out</span>}</h2>
              <span className={`rounded-full px-3 py-1 text-xs font-black uppercase tracking-wider ${out ? "bg-wayne-green text-white" : "bg-wayne-cream text-wayne-muted"}`}>{out ? `Out · ${out} order${out === 1 ? "" : "s"}` : orders.length ? "Back in store" : "No deliveries"}</span>
            </div>
            {driver.last_cashout_at ? <p className="text-xs text-wayne-muted">Last cashed out {time(driver.last_cashout_at)}</p> : null}
            {orders.length ? <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <thead><tr className="border-b border-wayne-border text-xs uppercase tracking-wider text-wayne-muted"><th className="py-2 pr-2">Ticket</th><th className="pr-2">Customer</th><th className="pr-2">Paid</th><th className="pr-4 text-right">Total</th><th className="w-28 pr-2">Tip</th><th /></tr></thead>
                <tbody>{orders.map((order) => {
                  const allowed = tipAllowed(order);
                  const raw = tips[order.order_id] ?? "";
                  const cents = dollarsToCents(raw);
                  const cap = maxTipCents(order);
                  const over = cents !== null && cents > cap;
                  const staleHold = order.paid_by === "card_held" && order.held_at && Date.now() - Date.parse(order.held_at) > 5 * 86_400_000;
                  const noCardTip = order.paid_by === "card_held" && cap === 0;
                  return <tr className="border-b border-wayne-border align-top last:border-0" key={order.order_id}>
                    {/* The slip number, big, so the tip on each paper slip is easy to match (owner, 2026-10-28). */}
                    <td className="py-2 pr-2 whitespace-nowrap"><span className="inline-block rounded-lg bg-wayne-green px-2 py-0.5 text-2xl font-black text-white">#{ticketNumber(order)}</span></td>
                    <td className="py-2 pr-2"><strong className="block">{order.customer_name || "Customer"}{order.is_test ? " · TEST" : ""}</strong><span className="block text-xs text-wayne-muted">{order.address}{order.city ? `, ${order.city}` : ""}</span>{staleHold ? <span className="block text-xs font-bold text-wayne-alert">Card approval expires soon — cash out today</span> : null}</td>
                    <td className="py-2 pr-2 text-xs font-bold">{paidByLabel(order)}</td>
                    <td className="py-2 pr-4 text-right font-bold">{allowed && cents && !over ? <>{formatCents(order.total_cents + cents)}<span className="block text-xs font-normal text-wayne-muted">{formatCents(order.total_cents)} + {formatCents(cents)} tip</span></> : formatCents(order.total_cents)}</td>
                    <td className="py-2 pr-2">{noCardTip ? <span className="text-xs font-bold text-wayne-alert">This card can&apos;t take a tip after the order (Stripe). The order is charged as is.</span> : allowed ? <>
                      <input aria-label={`Tip for order #${ticketNumber(order)}`} className={`min-h-11 w-24 rounded-lg border px-2 text-right text-base font-bold ${cents === null || over ? "border-wayne-alert" : "border-wayne-border"}`} inputMode="decimal" onChange={(event) => setTipDraft(order.order_id, event.target.value, dollarsToCents(event.target.value) ?? 0, "delivery")} placeholder="0.00" value={raw} />
                      <TipSavedNote error={drafts[order.order_id]?.error} state={tipSaveState(drafts[order.order_id])} terminal={drafts[order.order_id]?.terminal} />
                      {over ? <span className="block text-xs font-bold text-wayne-alert">Max {formatCents(cap)} on this card</span> : null}
                    </> : <span className="text-sm font-bold">{formatCents(order.tip_cents)}<span className="block text-xs font-normal text-wayne-muted">{order.paid_by === "paid" ? "tip paid online" : "charged at the counter"} · drawer pays it</span></span>}</td>
                    <td className="py-2 text-right">{order.status === "out_for_delivery" ? <button className="min-h-9 text-xs font-bold underline" disabled={busy !== null} onClick={() => { void act(`back-${order.order_id}`, { action: "unassign", order_id: order.order_id }); }} type="button">Take back</button> : null}</td>
                  </tr>;
                })}</tbody>
              </table>
            </div> : <p className="mt-3 text-sm text-wayne-muted">Nothing to cash out.</p>}

            {orders.length ? confirming ? <div className="mt-4 rounded-2xl border-2 border-wayne-green bg-wayne-green/5 p-4">
              <p className="text-sm font-black uppercase tracking-[0.16em] text-wayne-muted">Run down · {orders.length} {orders.length === 1 ? "delivery" : "deliveries"}</p>
              <table className="mt-2 w-full text-left text-sm">
                <thead><tr className="border-b border-wayne-border text-xs uppercase tracking-wider text-wayne-muted"><th className="py-1 pr-2">Ticket</th><th className="pr-2">Paid</th><th className="pr-2 text-right">Order</th><th className="pr-2 text-right">Tip</th><th className="pr-4 text-right">Total</th><th>Driver</th></tr></thead>
                <tbody>{cashoutLines(orders, tipCents).map((line) => <tr className="border-b border-wayne-border last:border-0" key={line.order.order_id}>
                  <td className="py-1 pr-2 text-xl font-black whitespace-nowrap">#{ticketNumber(line.order)}</td>
                  <td className="pr-2">{paidByShort[line.order.paid_by] ?? line.order.paid_by}</td>
                  <td className="pr-2 text-right">{formatCents(line.order.total_cents - (line.order.paid_by === "card" || line.order.paid_by === "paid" ? line.order.tip_cents : 0))}</td>
                  <td className="pr-2 text-right">{formatCents(line.tip)}</td>
                  {/* Order + tip: what the card is charged / the order comes to with its tip (owner, 2026-10-20). */}
                  <td className="pr-4 text-right font-black">{formatCents(line.order.paid_by === "card" || line.order.paid_by === "paid" ? line.order.total_cents : line.order.total_cents + line.tip)}</td>
                  <td className="text-xs">{rundownNote(line.order.paid_by, line.collected, line.storePays, line.keeps)}</td>
                </tr>)}</tbody>
              </table>
              <dl className="mt-3 grid grid-cols-2 gap-1 border-t border-wayne-border pt-3 text-base">
                <dt>Cash orders</dt><dd className="text-right font-bold">{formatCents(summary.cashOrders)}</dd>
                <dt>Card tips (store pays driver)</dt><dd className="text-right font-bold">− {formatCents(summary.cardTips)}</dd>
                <dt className="text-wayne-muted">Cash tips (driver keeps)</dt><dd className="text-right text-wayne-muted">{formatCents(summary.cashTips)}</dd>
              </dl>
              <p className="mt-3 border-t border-wayne-border pt-3 text-3xl font-black">{summary.handIn >= 0 ? `${driver.name} hands in ${formatCents(summary.handIn)}` : `Pay ${driver.name} ${formatCents(-summary.handIn)}`}</p>
              {summary.cardTips ? <p className="mt-1 text-sm text-wayne-muted">Confirming charges each delivery card once — the order plus its tip. The drawer pays the card tips to the driver.</p> : null}
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
