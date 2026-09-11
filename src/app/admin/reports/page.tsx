import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/access";
import { getStoreSettings } from "@/lib/content/queries";
import { formatCents } from "@/lib/menu/schemas";
import { getReportData } from "@/lib/reports/queries";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";
const dateSchema = z.iso.date();

function businessDate(timeZone: string, date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ from?: string | string[]; to?: string | string[] }> }) {
  await requirePermission("reports.view", "/admin/reports");
  const [settings, params] = await Promise.all([getStoreSettings(), searchParams]);
  const today = businessDate(settings.timezone);
  const rawFrom = Array.isArray(params.from) ? params.from[0] : params.from;
  const rawTo = Array.isArray(params.to) ? params.to[0] : params.to;
  const from = dateSchema.safeParse(rawFrom).success ? rawFrom! : today;
  const to = dateSchema.safeParse(rawTo).success && rawTo! >= from ? rawTo! : from;
  const report = await getReportData(from, to);
  const exportHref = (dataset: string) => `/api/reports/export?dataset=${dataset}&from=${from}&to=${to}`;
  return <main className="mx-auto max-w-6xl px-5 py-10">
    <div className="flex flex-wrap items-end justify-between gap-5"><div><p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Reporting</p><h1 className="mt-3 text-4xl font-black">Sales & operations</h1><p className="mt-3 max-w-3xl text-wayne-muted">All dates use Wayne&apos;s {settings.timezone} business day. Sales are authoritative order totals; refunds are recorded on the business date they were issued.</p></div><Button asChild variant="secondary"><Link href="/admin/orders">Order history</Link></Button></div>
    <Card className="mt-8 p-5"><form className="flex flex-wrap items-end gap-4" method="get"><Input defaultValue={from} label="From business date" name="from" type="date" /><Input defaultValue={to} label="Through business date" name="to" type="date" /><Button type="submit">Run report</Button><Button asChild variant="secondary"><Link href="/admin/reports">Today</Link></Button></form></Card>
    <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Metric label="Net sales" value={formatCents(report.summary.net_sales_cents)} /><Metric label="Orders" value={String(report.summary.order_count)} /><Metric label="Refunds issued" value={formatCents(report.summary.refund_cents)} /><Metric label="Average order" value={formatCents(report.summary.average_order_cents)} /></div>
    <Card className="mt-5 p-5"><h2 className="text-xl font-black">Reconciliation</h2><dl className="mt-4 grid gap-3 sm:grid-cols-3"><Metric label="Gross before discounts" value={formatCents(report.summary.gross_sales_cents)} /><Metric label="Discounts on orders" value={formatCents(report.summary.discount_cents)} /><Metric label="Net order totals less refunds" value={formatCents(report.summary.net_sales_cents)} /></dl></Card>
    <div className="mt-5 grid gap-5 lg:grid-cols-3"><Split title="By source" rows={report.summary.source_rows} /><Split title="By fulfillment" rows={report.summary.fulfillment_rows} /><Split title="By payment method" rows={report.summary.payment_rows} /></div>
    <div className="mt-8 grid gap-5 lg:grid-cols-2"><TrendChart title="Daily net sales" valueLabel="Net sales" rows={report.daily.map((row) => ({ label: row.service_date, value: row.net_sales_cents }))} formatValue={formatCents} /><TrendChart title="Daily orders" valueLabel="Orders" rows={report.daily.map((row) => ({ label: row.service_date, value: row.order_count }))} formatValue={String} /></div>
    <div className="mt-8 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-2xl font-black">Daily sales</h2><p className="text-sm text-wayne-muted">Refunds reduce the day they are issued.</p></div><Button asChild variant="secondary"><a href={exportHref("daily")}>Export daily CSV</a></Button></div>
    <ReportTable headers={["Business date", "Orders", "Order sales", "Refunds", "Net sales"]} rows={report.daily.map((row) => [row.service_date, String(row.order_count), formatCents(row.sales_cents), formatCents(row.refund_cents), formatCents(row.net_sales_cents)])} />
    <div className="mt-8 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-2xl font-black">Item sales</h2><p className="text-sm text-wayne-muted">Item/category names are snapshots retained with each historical order.</p></div><Button asChild variant="secondary"><a href={exportHref("items")}>Export items CSV</a></Button></div>
    <ReportTable headers={["Category", "Item", "Quantity", "Item sales"]} rows={report.items.map((row) => [row.category_name, row.item_name, String(row.quantity), formatCents(row.sales_cents)])} />
    <div className="mt-8"><Button asChild variant="secondary"><a href={exportHref("orders")}>Export orders CSV</a></Button></div>
  </main>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div><dt className="text-sm font-bold text-wayne-muted">{label}</dt><dd className="mt-1 text-2xl font-black">{value}</dd></div>; }
function Split({ title, rows }: { title: string; rows: Array<{ key: string; order_count: number; total_cents: number }> }) { return <Card className="p-5"><h2 className="text-xl font-black">{title}</h2>{rows.length ? <dl className="mt-4 grid gap-3">{rows.map((row) => <div className="flex items-end justify-between gap-3" key={row.key}><dt className="capitalize"><strong>{row.key.replaceAll("_", " ")}</strong><span className="ml-2 text-sm text-wayne-muted">{row.order_count} orders</span></dt><dd className="font-black">{formatCents(row.total_cents)}</dd></div>)}</dl> : <p className="mt-4 text-sm text-wayne-muted">No orders in this range.</p>}</Card>; }
function ReportTable({ headers, rows }: { headers: string[]; rows: string[][] }) { return <Card className="mt-4 overflow-x-auto"><table className="w-full min-w-150 text-left text-sm"><thead className="border-b border-wayne-border bg-wayne-cream"><tr>{headers.map((header) => <th className="px-4 py-3 font-black" key={header}>{header}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, index) => <tr className="border-b border-wayne-border last:border-0" key={`${row[0]}-${index}`}>{row.map((value, cell) => <td className={`px-4 py-3 ${cell > 1 ? "font-bold" : ""}`} key={`${value}-${cell}`}>{value}</td>)}</tr>) : <tr><td className="px-4 py-7 text-wayne-muted" colSpan={headers.length}>No report data in this date range.</td></tr>}</tbody></table></Card>; }
function TrendChart({ title, valueLabel, rows, formatValue }: { title: string; valueLabel: string; rows: Array<{ label: string; value: number }>; formatValue: (value: number) => string }) { const width = 640; const height = 220; const inset = 28; const values = rows.map((row) => row.value); const minimum = Math.min(0, ...values); const maximum = Math.max(0, ...values); const range = Math.max(maximum - minimum, 1); const y = (value: number) => height - inset - ((value - minimum) / range) * (height - inset * 2); const x = (index: number) => rows.length === 1 ? width / 2 : 24 + index * ((width - 48) / (rows.length - 1)); const points = rows.map((row, index) => `${x(index)},${y(row.value)}`).join(" "); return <Card className="p-5"><h2 className="text-xl font-black">{title}</h2><p className="mt-1 text-sm text-wayne-muted">Visual trend; the daily table below remains the detailed accessible data.</p>{rows.length ? <svg aria-label={`${title} chart`} className="mt-4 h-auto w-full" role="img" viewBox={`0 0 ${width} ${height}`}><line stroke="currentColor" strokeOpacity="0.35" x1="24" x2={width - 24} y1={y(0)} y2={y(0)} /><polyline fill="none" points={points} stroke="currentColor" strokeWidth="3" className="text-wayne-red" />{rows.map((row, index) => <circle aria-label={`${row.label}: ${valueLabel} ${formatValue(row.value)}`} cx={x(index)} cy={y(row.value)} fill="currentColor" key={row.label} r="4"><title>{`${row.label}: ${valueLabel} ${formatValue(row.value)}`}</title></circle>)}</svg> : <p className="mt-4 text-sm text-wayne-muted">No data in this range.</p>}</Card>; }
