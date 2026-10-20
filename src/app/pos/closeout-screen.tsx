"use client";

import { useCallback, useState, type ReactNode } from "react";
import { useVisiblePolling } from "@/components/ops/use-visible-polling";
import { Button } from "@/components/ui/button";
import { brandLabels, closeoutLayout, dayCloseoutSchema, expectedCash, sourceLabels, tipPayout, type DayCloseout } from "@/lib/closeout/schemas";
import { deliveryCloseoutLayout, deliveryDayReportSchema } from "@/lib/delivery/day-report";
import { formatCents } from "@/lib/menu/schemas";
import { getHardwareRuntime } from "@/stores/hardware-store";

function shiftDay(day: string, by: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
}

/**
 * Close Out (owner, 2026-10-13): the end of the day on one screen.
 *
 *   Sales — orders, food & drink, discounts, delivery fees, tax, tips, total
 *   Payments — cash, card, and card by brand (Visa, Mastercard, Amex, Discover)
 *   Online orders — totalled on their own
 *   Cash count — just the total counted, expected vs counted, over / short
 *                (owner, 2026-10-19: no bill-by-bill counting)
 *
 * "Close out the day" closes the open drawer with the count and keeps the
 * close out on file.  Any day can be printed on the receipt printer as a
 * store close out slip and a delivery close out slip (per driver).
 */
export function CloseoutScreen({ storeName, onOpenTips, tipPayoutName = "the owner" }: { storeName: string; onOpenTips?: () => void; /** Admin → Tips: who the card tips are paid out to. */ tipPayoutName?: string }) {
  const [day, setDay] = useState<string | null>(null);
  const [today, setToday] = useState("");
  const [report, setReport] = useState<DayCloseout | null>(null);
  const [error, setError] = useState("");
  const [typedTotal, setTypedTotal] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async (target: string | null) => {
    try {
      const response = await fetch(`/api/pos/closeout${target ? `?day=${target}` : ""}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body ? String(body.error) : "The close out is unavailable.");
      const parsed = dayCloseoutSchema.safeParse(body);
      if (!parsed.success) throw new Error("The close out could not be read.");
      setReport(parsed.data);
      setError("");
      if (!target) { setToday(parsed.data.day); setDay(parsed.data.day); }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The close out is unavailable.");
    }
  }, []);

  const refresh = useCallback(() => load(day), [day, load]);
  useVisiblePolling(refresh, 60_000);

  const typed = typedTotal.trim() ? Math.round(Number(typedTotal.replace(/[$,\s]/g, "")) * 100) : null;
  const counted = typed !== null && Number.isFinite(typed) && typed >= 0 ? typed : null;
  const isToday = Boolean(report && report.day === today);
  const expected = report ? expectedCash(report, isToday) : 0;
  const variance = counted === null ? null : counted - expected;
  const needsNote = variance !== null && Math.abs(variance) >= 500 && note.trim().length < 3;

  async function closeOut() {
    if (!report || counted === null || saving) return;
    if (needsNote) { setNotice("The cash is out by $5 or more — write what happened in the note first."); return; }
    setSaving(true); setNotice("");
    try {
      const response = await fetch("/api/pos/closeout", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ business_date: report.day, counted_cash_cents: counted, denominations: {}, note: note.trim(), close_drawer: report.day === today }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body ? String(body.error) : "The close out could not be saved.");
      setNotice("✓ Day closed out and saved.");
      await load(report.day);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The close out could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function print() {
    if (!report) return;
    const runtime = getHardwareRuntime();
    if (!runtime) { setNotice("Printing is still starting up. Try again in a moment."); return; }
    setNotice("Printing…");
    const result = await runtime.receiptPrinter.printLayout(closeoutLayout(report, storeName, counted ?? report.saved?.counted_cash_cents ?? null, report.day === today, tipPayoutName));
    setNotice(result.ok ? "Store close out sent to the receipt printer." : result.reason);
  }

  /** The day's delivery close out slip: every driver's deliveries, tips and cash (owner, 2026-10-19). */
  async function printDeliveries() {
    if (!report) return;
    const runtime = getHardwareRuntime();
    if (!runtime) { setNotice("Printing is still starting up. Try again in a moment."); return; }
    setNotice("Printing…");
    try {
      const response = await fetch(`/api/pos/delivery/day-report?day=${report.day}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body ? String(body.error) : "The delivery close out is unavailable.");
      const parsed = deliveryDayReportSchema.safeParse(body);
      if (!parsed.success) throw new Error("The delivery close out could not be read.");
      const result = await runtime.receiptPrinter.printLayout(deliveryCloseoutLayout(parsed.data, storeName));
      setNotice(result.ok ? "Delivery close out sent to the receipt printer." : result.reason);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "The delivery close out could not be printed.");
    }
  }

  if (!report) {
    return <div className="grid min-h-0 flex-1 place-items-center p-6 text-center">{error ? <p className="max-w-md rounded-2xl bg-wayne-alert-soft p-4 font-bold text-wayne-alert">{error}</p> : <p className="font-bold text-wayne-muted">Loading the close out…</p>}</div>;
  }

  const { sales, tenders, online } = report;
  const tips = tipPayout(report);
  const brands = Object.entries(report.card_brands).sort((a, b) => b[1].cents - a[1].cents);

  return <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
    <div className="mx-auto grid max-w-6xl gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-black">Close out · {new Date(`${report.day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}</h1>
        <Button onClick={() => setDay(shiftDay(report.day, -1))} size="sm" variant="secondary">← Day before</Button>
        {report.day !== today ? <Button onClick={() => setDay(today)} size="sm" variant="secondary">Today</Button> : null}
        {report.day < today ? <Button onClick={() => setDay(shiftDay(report.day, 1))} size="sm" variant="secondary">Next day →</Button> : null}
        <Button onClick={() => void print()} size="sm">🖨 Store close out</Button>
        <Button onClick={() => void printDeliveries()} size="sm">🖨 Delivery close out</Button>
      </div>
      {error ? <p className="rounded-xl bg-wayne-warn-soft p-2 text-sm font-bold">{error}</p> : null}
      {report.saved ? <p className="rounded-xl bg-wayne-ok-soft p-3 text-sm font-bold text-wayne-ok">✓ Closed out {new Date(report.saved.closed_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}{report.saved.closed_by_name ? ` by ${report.saved.closed_by_name}` : ""}: counted {formatCents(report.saved.counted_cash_cents)}, expected {formatCents(report.saved.expected_cash_cents)} ({varianceText(report.saved.variance_cents)}). Closing again replaces it.</p> : null}
      {/* Tips are not store income (owner, 2026-10-13): what to pay out, in one line. */}
      <div className="grid gap-3 rounded-3xl border-2 border-wayne-green bg-white p-4 shadow-sm sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <p className="text-sm font-black uppercase tracking-[0.16em] text-wayne-muted">Tips — not store income</p>
          <p className="mt-1 text-2xl font-black sm:text-3xl">Pay {tipPayoutName} <span className="text-wayne-green">{formatCents(tips.ownerCardTips)}</span> in card tips</p>
          <p className="mt-1 text-sm font-bold text-wayne-muted">{tips.ownerCardTipCount ? `${tips.ownerCardTipCount} card tip${tips.ownerCardTipCount === 1 ? "" : "s"} on pickup, walk-in and online pickup orders` : "No card tips yet today"}{tips.ownerCashTips ? ` · plus ${formatCents(tips.ownerCashTips)} tipped in cash` : ""}{tips.driverTips ? ` · delivery tips ${formatCents(tips.driverTips)} go to the drivers at their cash-out` : ""}</p>
        </div>
        <div className="rounded-2xl bg-wayne-cream p-3 text-right">
          <p className="text-xs font-black uppercase tracking-[0.14em] text-wayne-muted">Store income (no tips)</p>
          <p className="text-2xl font-black tabular-nums">{formatCents(tips.income)}</p>
        </div>
      </div>
      {tenders.card_held_for_tip_cents ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-wayne-gold bg-wayne-gold/15 p-3">
        <p className="font-black">💳 {formatCents(tenders.card_held_for_tip_cents)} in delivery cards still waiting for the driver&apos;s tip. Cash out the drivers (or charge them in Tips) before closing out.</p>
        {onOpenTips ? <Button onClick={onOpenTips} size="sm">Go to Tips</Button> : null}
      </div> : null}
      {report.unpaid.count ? <div className="rounded-xl border-2 border-wayne-alert bg-wayne-alert-soft p-3">
        <p className="font-black text-wayne-alert">⚠ {report.unpaid.count} order{report.unpaid.count === 1 ? "" : "s"} still not paid · {formatCents(report.unpaid.total_cents)}</p>
        <p className="mt-1 text-sm font-bold">{report.unpaid.orders.slice(0, 8).map((order) => `#${order.order_number.replace(/^W0*/, "")} ${order.customer_name || ""} ${formatCents(order.total_cents)}`).join(" · ")}{report.unpaid.orders.length > 8 ? " …" : ""}</p>
        <p className="mt-1 text-xs font-bold">Take their payment in Payments (or cancel them) before closing out, so the totals are right.</p>
      </div> : null}

      <div className="grid gap-3 lg:grid-cols-3">
        <Card title="Sales">
          <Row label="Orders" value={String(sales.order_count)} />
          <Row label="Items" value={String(sales.item_count)} />
          <Row label="Food & drink" value={formatCents(sales.subtotal_cents)} />
          {sales.discount_cents ? <Row label="Discounts" value={formatCents(-sales.discount_cents)} /> : null}
          <Row label="Delivery fees" value={formatCents(sales.delivery_fee_cents)} />
          <Row label="Tax" value={formatCents(sales.tax_cents)} />
          <Row label="Tips (paid out, not income)" value={formatCents(sales.tip_cents)} />
          <Row big label="Total collected" value={formatCents(sales.total_cents)} />
          <Row big label="Store income" value={formatCents(tips.income)} />
          <div className="mt-2 border-t border-wayne-border pt-2 text-sm">
            <Row label={`Pickup (${sales.pickup_count})`} value={formatCents(sales.pickup_total_cents)} />
            <Row label={`Delivery (${sales.delivery_count})`} value={formatCents(sales.delivery_total_cents)} />
            {Object.entries(report.by_source).map(([source, value]) => <Row key={source} label={`${sourceLabels[source] ?? source} (${value.count})`} value={formatCents(value.total_cents)} />)}
          </div>
        </Card>

        <Card title="Payments">
          <Row big label={`Cash (${tenders.cash_count})`} value={formatCents(tenders.cash_cents)} />
          <div className="pl-3 text-sm text-wayne-muted">
            <Row label="At the counter" value={formatCents(tenders.cash_at_counter_cents)} />
            <Row label="From drivers" value={formatCents(tenders.cash_from_drivers_cents)} />
          </div>
          <Row big label={`Card (${tenders.card_count})`} value={formatCents(tenders.card_cents)} />
          <div className="pl-3 text-sm">
            {brands.length ? brands.map(([brand, value]) => <Row key={brand} label={`${brandLabels[brand] ?? brand} (${value.count})`} value={formatCents(value.cents)} />) : <p className="text-wayne-muted">No card payments.</p>}
          </div>
          <div className="mt-2 border-t border-wayne-border pt-2 text-sm">
            <Row label="Card in store" value={formatCents(tenders.card_in_store_cents)} />
            <Row label="Card online" value={formatCents(tenders.card_online_cents)} />
            {tenders.card_held_for_tip_cents ? <Row label="Cards waiting for tips" value={formatCents(tenders.card_held_for_tip_cents)} /> : null}
            <Row label="Card tips" value={formatCents(tenders.card_tips_cents)} />
            {tenders.other_cents ? <Row label="Other" value={formatCents(tenders.other_cents)} /> : null}
            {report.refunds.count ? <Row label={`Refunds (${report.refunds.count})`} value={formatCents(-report.refunds.cents)} /> : null}
            {report.voids.count ? <Row label={`Voided orders (${report.voids.count})`} value={formatCents(report.voids.total_cents)} /> : null}
          </div>
        </Card>

        <Card title="Online orders">
          <Row label={`Orders (${online.pickup_count} pickup · ${online.delivery_count} delivery)`} value={String(online.order_count)} />
          <Row label="Food & drink" value={formatCents(online.subtotal_cents)} />
          {online.discount_cents ? <Row label="Discounts" value={formatCents(-online.discount_cents)} /> : null}
          <Row label="Delivery fees" value={formatCents(online.delivery_fee_cents)} />
          <Row label="Tax" value={formatCents(online.tax_cents)} />
          <Row label="Tips" value={formatCents(online.tip_cents)} />
          <Row big label="Online total" value={formatCents(online.total_cents)} />
          <div className="mt-2 border-t border-wayne-border pt-2 text-sm">
            <Row label="Paid by card online" value={formatCents(online.paid_card_cents)} />
            {online.paid_cash_cents ? <Row label="Paid cash" value={formatCents(online.paid_cash_cents)} /> : null}
            {online.unpaid_count ? <Row label={`Not paid (${online.unpaid_count})`} value={formatCents(online.unpaid_cents)} /> : null}
            {Object.entries(report.card_brands).filter(([, value]) => value.online_cents).map(([brand, value]) => <Row key={brand} label={`  ${brandLabels[brand] ?? brand}`} value={formatCents(value.online_cents)} />)}
          </div>
          <p className="mt-2 text-xs text-wayne-muted">In store (counter + phone): {report.in_store.order_count} orders · {formatCents(report.in_store.total_cents)}</p>
        </Card>
      </div>

      <Card title="Cash in the drawer">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div>
            {/* Just the total (owner, 2026-10-19): no bill-by-bill counting. */}
            <label className="grid gap-1 text-sm font-bold">Total cash counted ($)
              <input className="min-h-14 rounded-lg border border-wayne-border px-3 text-2xl font-black" inputMode="decimal" onChange={(event) => setTypedTotal(event.target.value)} placeholder="0.00" value={typedTotal} />
            </label>
          </div>
          <div className="grid content-start gap-2 rounded-2xl bg-wayne-cream p-4">
            <Row big label="Expected in the drawer" value={formatCents(expected)} />
            {(isToday ? report.drawer.open_shifts : []).map((shift) => <p className="text-xs text-wayne-muted" key={shift.id}>{shift.register_label}: float {formatCents(shift.opening_cash_cents)} + cash {formatCents(shift.cash_sales_cents)}{shift.driver_cash_cents ? ` + drivers ${formatCents(shift.driver_cash_cents)}` : ""}{shift.paid_in_cents ? ` + paid in ${formatCents(shift.paid_in_cents)}` : ""}{shift.paid_out_cents ? ` − paid out ${formatCents(shift.paid_out_cents)}` : ""}{shift.drop_cents ? ` − drops ${formatCents(shift.drop_cents)}` : ""}{shift.cash_refunds_cents ? ` − refunds ${formatCents(shift.cash_refunds_cents)}` : ""}</p>)}
            {!isToday || !report.drawer.open_shifts.length ? <p className="text-xs text-wayne-muted">{report.drawer.closed_today.length ? "No drawer open — compared with the drawers closed today." : "No drawer was opened — compared with the day's cash takings."}</p> : null}
            <Row big label="Counted (real)" value={counted === null ? "—" : formatCents(counted)} />
            <p className={`rounded-xl p-3 text-center text-2xl font-black ${variance === null ? "bg-white text-wayne-muted" : variance === 0 ? "bg-wayne-ok-soft text-wayne-ok" : variance > 0 ? "bg-wayne-gold/30" : "bg-wayne-alert-soft text-wayne-alert"}`}>{variance === null ? "Count the cash" : varianceText(variance)}</p>
            <label className="grid gap-1 text-sm font-bold">Note {needsNote ? <span className="text-wayne-alert">(required — out by $5 or more)</span> : "(optional)"}
              <textarea className="rounded-lg border border-wayne-border p-2 font-normal" maxLength={1000} onChange={(event) => setNote(event.target.value)} rows={2} value={note} />
            </label>
            <Button className="min-h-14 text-lg" disabled={counted === null || saving} onClick={() => void closeOut()}>{saving ? "Closing…" : report.saved ? "Close out again" : "Close out the day"}</Button>
            {report.day === today && report.drawer.open_shifts.length ? <p className="text-xs text-wayne-muted">This also closes the open drawer with this count.</p> : null}
            {notice ? <p className="rounded-lg bg-white p-2 text-sm font-bold" role="status">{notice}</p> : null}
          </div>
        </div>
      </Card>
    </div>
  </div>;
}

function varianceText(cents: number) {
  return cents === 0 ? "Exactly right" : cents > 0 ? `Over ${formatCents(cents)}` : `Short ${formatCents(-cents)}`;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-3xl bg-white p-4 shadow-sm"><h2 className="mb-2 text-lg font-black">{title}</h2>{children}</section>;
}

function Row({ label, value, big = false }: { label: string; value: string; big?: boolean }) {
  return <div className={`flex justify-between gap-3 py-0.5 ${big ? "text-lg font-black" : ""}`}><span>{label}</span><span className="tabular-nums">{value}</span></div>;
}
