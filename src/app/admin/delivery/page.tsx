import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { AutoRefresh } from "@/components/ops/auto-refresh";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { getStoreSettings } from "@/lib/content/queries";
import { getDeliveryMetrics, getDispatchBoard } from "@/lib/delivery/queries";
import { driverStepLabels, formatAddress, minutesBetween, type DeliveryMetrics, type DispatchBoard } from "@/lib/delivery/schemas";
import { formatCents } from "@/lib/menu/schemas";
import { assignDelivery, releaseDelivery } from "./actions";

export const metadata: Metadata = { title: "Delivery" };
export const dynamic = "force-dynamic";
const dateSchema = z.iso.date();

function businessDate(timeZone: string, date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function clockTime(value: string | null, timeZone: string) {
  return value ? new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value)) : "—";
}
const single = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

type Search = { from?: string | string[]; to?: string | string[]; error?: string | string[]; saved?: string | string[] };

export default async function DeliveryPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await getCurrentAccess();
  const canDispatch = hasPermission(access, "delivery.dispatch");
  const canReport = hasPermission(access, "reports.view");
  if (!canDispatch && !canReport) return <main className="mx-auto max-w-6xl px-5 py-10"><Card className="p-6"><h1 className="text-2xl font-black">Delivery</h1><p className="mt-3 text-wayne-muted">Your account cannot dispatch deliveries or read delivery analytics. Ask an owner for access.</p></Card></main>;

  const [settings, params] = await Promise.all([getStoreSettings(), searchParams]);
  const today = businessDate(settings.timezone);
  const rawFrom = single(params.from);
  const rawTo = single(params.to);
  const from = dateSchema.safeParse(rawFrom).success ? rawFrom! : today;
  const to = dateSchema.safeParse(rawTo).success && rawTo! >= from ? rawTo! : from;

  let board: DispatchBoard | null = null;
  let boardError = "";
  if (canDispatch) {
    try { board = await getDispatchBoard(); } catch { boardError = "The live dispatch board could not be loaded. Refresh to try again."; }
  }
  let metrics: DeliveryMetrics | null = null;
  let metricsError = "";
  if (canReport) {
    try { metrics = await getDeliveryMetrics(from, to); } catch { metricsError = "Delivery analytics could not be loaded for this range."; }
  }

  const error = single(params.error);
  const saved = single(params.saved);

  return <main className="mx-auto max-w-6xl px-5 py-10">
    <div className="flex flex-wrap items-end justify-between gap-5">
      <div>
        <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Delivery operations</p>
        <h1 className="mt-3 text-4xl font-black">Dispatch &amp; drivers</h1>
        <p className="mt-3 max-w-3xl text-wayne-muted">Assign ready deliveries to a driver, watch them move, and see what each driver delivered and collected. Card payment at the door stays off until the payment processor is live.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3"><AutoRefresh label="Updates automatically" /><Button asChild variant="secondary"><Link href="/admin/orders">Order history</Link></Button></div>
    </div>

    {error ? <div className="mt-6 rounded-xl border border-wayne-alert/50 bg-wayne-alert-soft p-4 font-bold text-wayne-alert" role="alert">{error}</div> : null}
    {saved ? <div className="mt-6 rounded-xl border border-wayne-ok/50 bg-wayne-ok-soft p-4 font-bold text-wayne-ok" role="status">{saved}</div> : null}

    {canDispatch ? <section className="mt-8">
      <h2 className="text-2xl font-black">Live deliveries</h2>
      {boardError ? <p className="mt-3 rounded-xl border border-wayne-warn/50 bg-wayne-warn-soft p-4 font-bold">{boardError}</p> : null}
      <div className="mt-4 grid gap-4">
        {(board?.orders ?? []).map((order) => {
          const assignment = order.assignment;
          const assignable = order.status !== "completed" && order.status !== "cancelled";
          return <Card className="p-5" key={order.order_id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-2xl font-black">{order.order_number}</h3>
                  <Badge>{order.status.replaceAll("_", " ")}</Badge>
                  {assignment ? <Badge className="bg-wayne-info-soft text-wayne-info">{driverStepLabels[assignment.assignment_status]}</Badge> : <Badge className="bg-wayne-cream-deep text-wayne-muted">Unassigned</Badge>}
                </div>
                <p className="mt-2 font-bold">{order.customer_name} · {order.customer_phone}</p>
                <p className="text-sm text-wayne-muted">{formatAddress(order.address) || "No address on this order"}</p>
                <p className="mt-2 text-sm text-wayne-muted">
                  Placed {clockTime(order.placed_at, settings.timezone)} · promised {clockTime(order.promised_at, settings.timezone)} · {order.amount_due_cents > 0 ? `${formatCents(order.amount_due_cents)} cash due` : "already paid"}
                  {assignment?.picked_up_at ? ` · out ${minutesBetween(assignment.picked_up_at, new Date().toISOString())} min` : ""}
                </p>
                {assignment ? <p className="mt-1 text-sm font-bold">Driver: {assignment.driver_name ?? "Removed staff"}{assignment.self_claimed ? " (self-claimed)" : ""}</p> : null}
              </div>
              <p className="text-2xl font-black">{formatCents(order.total_cents)}</p>
            </div>

            {assignable ? <div className="mt-5 grid gap-4 border-t border-wayne-border pt-5 lg:grid-cols-2">
              <form action={assignDelivery} className="flex flex-wrap items-end gap-3">
                <input name="order_id" type="hidden" value={order.order_id} />
                <label className="grid gap-2 text-sm font-semibold" htmlFor={`driver-${order.order_id}`}>
                  {assignment ? "Reassign to" : "Assign to"}
                  <select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3" defaultValue={assignment?.driver_id ?? ""} id={`driver-${order.order_id}`} name="driver_id" required>
                    <option value="">Choose a driver</option>
                    {(board?.drivers ?? []).map((driver) => <option key={driver.driver_id} value={driver.driver_id}>{driver.display_name} ({driver.active_count} active)</option>)}
                  </select>
                </label>
                <Button type="submit">{assignment ? "Reassign" : "Assign"}</Button>
              </form>
              {assignment && assignment.assignment_status !== "delivered" ? <form action={releaseDelivery} className="flex flex-wrap items-end gap-3">
                <input name="order_id" type="hidden" value={order.order_id} />
                <Input id={`release-${order.order_id}`} label="Release reason" maxLength={500} name="reason" placeholder="Driver went home" required />
                <Button type="submit" variant="secondary">Release</Button>
              </form> : null}
            </div> : null}
          </Card>;
        })}
        {board && !board.orders.length && !boardError ? <Card className="p-10 text-center"><h3 className="text-xl font-black">No delivery orders right now</h3><p className="mt-2 text-wayne-muted">Delivery orders appear here as soon as they are placed.</p></Card> : null}
        {board && !board.drivers.length ? <p className="rounded-xl border border-wayne-warn/50 bg-wayne-warn-soft p-4 font-bold">No active staff member has the driver role yet. Add one under Staff before assigning deliveries.</p> : null}
      </div>
    </section> : null}

    {canReport ? <section className="mt-12">
      <h2 className="text-2xl font-black">Driver performance</h2>
      <p className="mt-1 text-wayne-muted">Counted by the {settings.timezone} business day a delivery was assigned.</p>
      <Card className="mt-4 p-5"><form className="flex flex-wrap items-end gap-4" method="get">
        <Input defaultValue={from} label="From business date" name="from" type="date" />
        <Input defaultValue={to} label="Through business date" name="to" type="date" />
        <Button type="submit">Run</Button>
        <Button asChild variant="secondary"><Link href="/admin/delivery">Today</Link></Button>
      </form></Card>
      {metricsError ? <p className="mt-4 rounded-xl border border-wayne-warn/50 bg-wayne-warn-soft p-4 font-bold">{metricsError}</p> : null}
      {metrics ? <>
        <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Deliveries completed" value={String(metrics.totals.delivered_count)} />
          <Metric label="Cash collected" value={formatCents(metrics.totals.cash_collected_cents)} />
          <Metric label="Average door time" value={`${metrics.totals.average_door_minutes} min`} />
          <Metric label="Late past promise" value={String(metrics.totals.late_count)} />
        </dl>
        <Card className="mt-5 p-5"><dl className="grid gap-3 sm:grid-cols-4">
          <Metric label="Assigned" value={String(metrics.totals.assigned_count)} />
          <Metric label="Still in progress" value={String(metrics.totals.in_progress_count)} />
          <Metric label="Delivered sales" value={formatCents(metrics.totals.delivered_sales_cents)} />
          <Metric label="Cash short" value={formatCents(metrics.totals.cash_short_cents)} />
        </dl></Card>
        <Card className="mt-5 overflow-x-auto"><table className="w-full min-w-150 text-left text-sm">
          <thead className="border-b border-wayne-border bg-wayne-cream"><tr>{["Driver", "Delivered", "Delivered sales", "Cash collected", "Cash short", "Average door time", "Late", "Released"].map((header) => <th className="px-4 py-3 font-black" key={header}>{header}</th>)}</tr></thead>
          <tbody>{metrics.drivers.length ? metrics.drivers.map((driver) => <tr className="border-b border-wayne-border last:border-0" key={driver.driver_id ?? driver.driver_name}>
            <td className="px-4 py-3 font-bold">{driver.driver_name}</td>
            <td className="px-4 py-3">{driver.delivered_count} of {driver.assigned_count}</td>
            <td className="px-4 py-3">{formatCents(driver.delivered_sales_cents)}</td>
            <td className="px-4 py-3 font-bold">{formatCents(driver.cash_collected_cents)}</td>
            <td className={`px-4 py-3 ${driver.cash_short_cents > 0 ? "font-black text-wayne-red" : ""}`}>{formatCents(driver.cash_short_cents)}</td>
            <td className="px-4 py-3">{driver.average_door_minutes} min</td>
            <td className="px-4 py-3">{driver.late_count}</td>
            <td className="px-4 py-3">{driver.released_count}</td>
          </tr>) : <tr><td className="px-4 py-7 text-wayne-muted" colSpan={8}>No deliveries were assigned in this range.</td></tr>}</tbody>
        </table></Card>
        <h3 className="mt-8 text-xl font-black">Exceptions</h3>
        <Card className="mt-3 overflow-x-auto"><table className="w-full min-w-150 text-left text-sm">
          <thead className="border-b border-wayne-border bg-wayne-cream"><tr>{["Order", "Driver", "Issue", "Detail", "When"].map((header) => <th className="px-4 py-3 font-black" key={header}>{header}</th>)}</tr></thead>
          <tbody>{metrics.exceptions.length ? metrics.exceptions.map((row, index) => <tr className="border-b border-wayne-border last:border-0" key={`${row.order_number}-${row.issue}-${index}`}>
            <td className="px-4 py-3 font-bold">{row.order_number}</td>
            <td className="px-4 py-3">{row.driver_name}</td>
            <td className="px-4 py-3 font-bold">{row.issue}</td>
            <td className="px-4 py-3">{row.detail}</td>
            <td className="px-4 py-3">{clockTime(row.occurred_at, settings.timezone)}</td>
          </tr>) : <tr><td className="px-4 py-7 text-wayne-muted" colSpan={5}>No delivery exceptions in this range.</td></tr>}</tbody>
        </table></Card>
      </> : null}
    </section> : null}
  </main>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-sm font-bold text-wayne-muted">{label}</dt><dd className="mt-1 text-2xl font-black">{value}</dd></div>;
}
