import type { Metadata } from "next";
import Link from "next/link";
import { AutoRefresh } from "@/components/ops/auto-refresh";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/access";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import { getStoreSettings } from "@/lib/content/queries";
import { dashboardPresets, resolveDashboardRange } from "@/lib/dashboard/range";
import { getDashboard, getSetupStatus } from "@/lib/dashboard/queries";
import { goLiveChecklist, type Dashboard } from "@/lib/dashboard/schemas";
import { formatCents } from "@/lib/menu/schemas";
import { titleCase } from "@/lib/orders/admin-format";
import { businessDate } from "@/lib/time/zoned";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const areas: Array<{ href: string; title: string; description: string; permission: Permission }> = [
  { href: "/admin/orders", title: "Orders", description: "Search history, hand off, complete, or cancel orders.", permission: "orders.view" },
  { href: "/pos", title: "Front POS", description: "Walk-in and phone orders, plus the open-orders counter view.", permission: "pos.access" },
  { href: "/kitchen", title: "Kitchen", description: "Live tickets with accept, cook, ready, and hand-off.", permission: "kitchen.access" },
  { href: "/admin/calendar", title: "Order calendar", description: "Daily order counts and sales by business date.", permission: "orders.view" },
  { href: "/admin/reports", title: "Reports", description: "Sales, refunds, items, and CSV exports.", permission: "reports.view" },
  { href: "/admin/customers", title: "Customers", description: "Profiles, order metrics, consent, and segments.", permission: "customers.view" },
  { href: "/admin/segments", title: "Segments", description: "VIP, frequent, and inactivity rules.", permission: "segments.manage" },
  { href: "/admin/promotions", title: "Promotions", description: "Promo codes, schedules, and usage limits.", permission: "promotions.manage" },
  { href: "/admin/menu", title: "Menu", description: "Categories, items, sizes, modifiers, photos, sold-out.", permission: "menu.manage" },
  { href: "/admin/settings", title: "Website & business settings", description: "Hours, tax, delivery area, fees, and page copy.", permission: "content.manage" },
  { href: "/admin/staff", title: "Staff & roles", description: "Individual sign-ins and role access.", permission: "staff.view" },
  { href: "/admin/printing", title: "Print queue", description: "Pending and failed kitchen tickets.", permission: "printing.manage" },
  { href: "/admin/integrations", title: "Hanafy integration", description: "Event delivery health and safe replay.", permission: "integrations.manage" },
  { href: "/admin/audit", title: "Audit log", description: "Who changed what, and server errors.", permission: "audit.view" },
];

type Search = { range?: string; from?: string; to?: string };

export default async function AdminDashboardPage({ searchParams }: { searchParams: Promise<Search> }) {
  const access = await requirePermission("admin.access", "/admin");
  const [params, settings, setup] = await Promise.all([searchParams, getStoreSettings(), getSetupStatus()]);
  const canReport = hasPermission(access, "reports.view");
  const range = resolveDashboardRange(params.range, businessDate(settings.timezone), params.from, params.to);
  const dashboard = canReport ? await getDashboard(range.from, range.to) : null;
  const checklist = goLiveChecklist(setup);
  const remaining = checklist.filter((item) => !item.done);
  const attention = [
    setup.stale_open_order_count ? { text: `${setup.stale_open_order_count} order${setup.stale_open_order_count === 1 ? " has" : "s have"} been open for more than a day`, href: "/admin/orders?status=placed" } : null,
    setup.failed_print_job_count ? { text: `${setup.failed_print_job_count} kitchen ticket${setup.failed_print_job_count === 1 ? "" : "s"} failed to print`, href: "/admin/printing" } : null,
    setup.hanafy_failed_count ? { text: `${setup.hanafy_failed_count} Hanafy event${setup.hanafy_failed_count === 1 ? "" : "s"} failed delivery and will retry`, href: "/admin/integrations" } : null,
    setup.pending_staff_count ? { text: `${setup.pending_staff_count} sign-in${setup.pending_staff_count === 1 ? " is" : "s are"} waiting for access`, href: "/admin/staff" } : null,
    setup.test_ordering_enabled ? { text: "Payments are in TEST / MANUAL mode — no cards are charged", href: "/admin/settings" } : null,
  ].filter((item): item is { text: string; href: string } => item !== null);

  return <main className="mx-auto max-w-6xl px-5 py-10">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Dashboard</p><h1 className="mt-3 text-4xl font-black">Wayne&apos;s Pizza today</h1><p className="mt-2 text-wayne-muted">{setup.open_order_count} open order{setup.open_order_count === 1 ? "" : "s"} right now · all figures use the {settings.timezone} business day</p></div><AutoRefresh intervalMs={30_000} live /></div>

    {remaining.length ? <Card className="mt-7 border-amber-300 p-5"><h2 className="text-xl font-black">Before going live · {checklist.length - remaining.length} of {checklist.length} done</h2><ul className="mt-3 grid gap-2 md:grid-cols-2">{checklist.map((item) => <li className="flex gap-3" key={item.label}><span aria-hidden="true" className={`mt-1 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-black ${item.done ? "bg-green-600 text-white" : "border-2 border-amber-500"}`}>{item.done ? "✓" : ""}</span><div><Link className="font-bold underline" href={item.href}>{item.label}</Link><span className="sr-only">{item.done ? " (done)" : " (to do)"}</span><p className="text-sm text-wayne-muted">{item.detail}</p></div></li>)}</ul></Card> : null}

    {attention.length ? <div className="mt-5 grid gap-2">{attention.map((item) => <Link className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 font-bold" href={item.href} key={item.text}>{item.text} →</Link>)}</div> : null}

    {dashboard ? <DashboardBody dashboard={dashboard} preset={range.preset} tipsEnabled={settings.tips_enabled} /> : <p className="mt-7 rounded-xl bg-wayne-cream p-4">Sales figures are visible to owners and managers with report access.</p>}

    <h2 className="mt-10 text-2xl font-black">Manage</h2>
    <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{areas.filter((area) => hasPermission(access, area.permission)).map((area) => <Link href={area.href} key={area.href}><Card className="h-full p-5 transition hover:-translate-y-0.5 hover:shadow-md"><h3 className="text-lg font-black">{area.title}</h3><p className="mt-1 text-sm text-wayne-muted">{area.description}</p></Card></Link>)}</div>
  </main>;
}

function DashboardBody({ dashboard, preset, tipsEnabled }: { dashboard: Dashboard; preset: string; tipsEnabled: boolean }) {
  const rangeLabel = dashboard.from_date === dashboard.through_date ? dashboard.from_date : `${dashboard.from_date} – ${dashboard.through_date}`;
  const pos = dashboard.source_rows.filter((row) => row.key !== "online");
  const posTotals = { order_count: pos.reduce((sum, row) => sum + row.order_count, 0), total_cents: pos.reduce((sum, row) => sum + row.total_cents, 0) };
  const find = (rows: Dashboard["source_rows"], key: string) => rows.find((row) => row.key === key) ?? { order_count: 0, total_cents: 0 };
  const mix = dashboard.customer_mix;
  return <>
    <div className="mt-8 flex flex-wrap items-end gap-2" aria-label="Time range">{dashboardPresets.filter(([value]) => value !== "custom").map(([value, label]) => <Button asChild key={value} variant={preset === value ? "primary" : "secondary"}><Link href={value === "today" ? "/admin" : `/admin?range=${value}`}>{label}</Link></Button>)}
      <form className="ml-auto flex flex-wrap items-end gap-2" method="get"><input name="range" type="hidden" value="custom" /><Input defaultValue={dashboard.from_date} label="From" name="from" type="date" /><Input defaultValue={dashboard.through_date} label="Through" name="to" type="date" /><Button variant={preset === "custom" ? "primary" : "secondary"}>Apply</Button></form></div>
    <p className="mt-3 text-sm font-bold text-wayne-muted">{rangeLabel}</p>

    <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Tile hint="Order totals after discounts, less refunds" label="Net sales" value={formatCents(dashboard.net_sales_cents)} />
      <Tile hint="Items + delivery fees + tax + tips, before discounts" label="Gross sales" value={formatCents(dashboard.gross_sales_cents)} />
      <Tile hint={dashboard.cancelled_count ? `${dashboard.cancelled_count} cancelled (${formatCents(dashboard.cancelled_cents)}) not counted` : "Cancelled orders are excluded"} label="Orders" value={String(dashboard.order_count)} />
      <Tile label="Average order" value={formatCents(dashboard.average_order_cents)} />
    </div>
    <dl className="mt-4 grid gap-3 rounded-2xl border border-wayne-border bg-white p-5 sm:grid-cols-3 lg:grid-cols-6">
      <Small label="Item sales" value={formatCents(dashboard.item_sales_cents)} /><Small label="Discounts" value={formatCents(dashboard.discount_cents)} /><Small label="Refunds" value={formatCents(dashboard.refund_cents)} /><Small label="Tax collected" value={formatCents(dashboard.tax_cents)} /><Small label="Delivery fees" value={formatCents(dashboard.delivery_fee_cents)} />{tipsEnabled || dashboard.tip_cents ? <Small label="Tips" value={formatCents(dashboard.tip_cents)} /> : <Small label="Tips" value="Off" />}
    </dl>

    <div className="mt-5 grid gap-4 md:grid-cols-3">
      <Mix rows={[["Pickup", find(dashboard.fulfillment_rows, "pickup")], ["Delivery", find(dashboard.fulfillment_rows, "delivery")]]} title="Pickup vs delivery" />
      <Mix rows={[["Online", find(dashboard.source_rows, "online")], ["POS / phone / walk-in", posTotals]]} title="Where orders came from" />
      <Mix rows={[["Card", find(dashboard.payment_rows, "card")], ["Cash", find(dashboard.payment_rows, "cash")], ["Test / manual", find(dashboard.payment_rows, "test_manual")]]} title="Payment method" />
    </div>

    <div className="mt-5 grid gap-4 lg:grid-cols-2">
      <HourChart format={formatCents} rows={dashboard.hourly.map((row) => ({ hour: row.hour, value: row.sales_cents }))} title="Sales by hour" />
      <HourChart format={String} rows={dashboard.hourly.map((row) => ({ hour: row.hour, value: row.order_count }))} title="Orders by hour" />
    </div>

    <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1fr_18rem]">
      <Card className="p-5"><h2 className="text-lg font-black">Top-selling items</h2>{dashboard.top_items.length ? <ol className="mt-3 grid gap-2">{dashboard.top_items.map((item, index) => <li className="flex justify-between gap-3" key={item.item_name}><span><span className="mr-2 text-wayne-muted">{index + 1}.</span>{item.item_name}</span><span className="whitespace-nowrap font-bold">{item.quantity} · {formatCents(item.sales_cents)}</span></li>)}</ol> : <Empty />}</Card>
      <Card className="p-5"><h2 className="text-lg font-black">Recent orders</h2>{dashboard.recent_orders.length ? <ul className="mt-3 grid gap-2">{dashboard.recent_orders.map((order) => <li className="flex justify-between gap-3" key={order.id}><Link className="underline" href={`/admin/orders/${order.id}`}>{order.order_number} · {order.customer_name}</Link><span className={`whitespace-nowrap text-sm font-bold ${order.status === "cancelled" ? "text-red-700 line-through" : ""}`}>{titleCase(order.status)} · {formatCents(order.total_cents)}</span></li>)}</ul> : <Empty />}</Card>
      <Card className="p-5"><h2 className="text-lg font-black">New vs returning</h2><dl className="mt-3 grid gap-2"><Row label="New customers" value={`${mix.new_customers} (${mix.new_customer_orders} orders)`} /><Row label="Returning customers" value={`${mix.returning_customers} (${mix.returning_customer_orders} orders)`} /><Row label="Walk-ins, no profile" value={`${mix.guest_orders} orders`} /></dl><p className="mt-3 text-xs text-wayne-muted">&ldquo;New&rdquo; means the customer&apos;s first order falls in this range.</p></Card>
    </div>
  </>;
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) { return <Card className="p-5"><p className="text-sm font-bold text-wayne-muted">{label}</p><p className="mt-1 text-3xl font-black tabular-nums">{value}</p>{hint ? <p className="mt-1 text-xs text-wayne-muted">{hint}</p> : null}</Card>; }
function Small({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs font-bold uppercase tracking-wide text-wayne-muted">{label}</dt><dd className="mt-1 text-lg font-black tabular-nums">{value}</dd></div>; }
function Row({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3"><dt>{label}</dt><dd className="font-bold">{value}</dd></div>; }
function Empty() { return <p className="mt-3 text-sm text-wayne-muted">No orders in this range.</p>; }
function Mix({ title, rows }: { title: string; rows: Array<[string, { order_count: number; total_cents: number }]> }) {
  const total = rows.reduce((sum, [, row]) => sum + row.total_cents, 0);
  return <Card className="p-5"><h2 className="text-lg font-black">{title}</h2><dl className="mt-3 grid gap-3">{rows.map(([label, row]) => <div key={label}><div className="flex justify-between gap-3"><dt>{label} <span className="text-sm text-wayne-muted">· {row.order_count} order{row.order_count === 1 ? "" : "s"}</span></dt><dd className="font-bold tabular-nums">{formatCents(row.total_cents)}</dd></div><div aria-hidden="true" className="mt-1 h-1.5 rounded-full bg-stone-100"><div className="h-1.5 rounded-full bg-wayne-red" style={{ width: `${total ? Math.round((row.total_cents / total) * 100) : 0}%` }} /></div></div>)}</dl></Card>;
}

function HourChart({ title, rows, format }: { title: string; rows: Array<{ hour: number; value: number }>; format: (value: number) => string }) {
  const max = Math.max(...rows.map((row) => row.value), 0);
  const label = (hour: number) => `${hour % 12 || 12}${hour < 12 ? "a" : "p"}`;
  return <Card className="p-5"><h2 className="text-lg font-black">{title}</h2>
    {max === 0 ? <Empty /> : <>
      <div className="mt-4 flex h-40 items-end gap-0.5 border-b border-stone-300" role="img" aria-label={`${title}: busiest hour ${label(rows.reduce((best, row) => row.value > best.value ? row : best).hour)}`}>
        {rows.map((row) => <div className="group relative flex h-full flex-1 items-end" key={row.hour}><div className="w-full rounded-t bg-wayne-red transition-opacity group-hover:opacity-80" style={{ height: row.value ? `${Math.max(3, (row.value / max) * 100)}%` : "0" }} /><span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-wayne-ink px-2 py-1 text-xs text-white group-hover:block">{label(row.hour)} · {format(row.value)}</span></div>)}
      </div>
      <div aria-hidden="true" className="mt-1 flex justify-between text-xs text-wayne-muted"><span>12a</span><span>6a</span><span>12p</span><span>6p</span><span>11p</span></div>
      <details className="mt-3 text-sm"><summary className="cursor-pointer font-bold">View as table</summary><table className="mt-2 w-full"><tbody>{rows.filter((row) => row.value).map((row) => <tr className="border-b border-wayne-border/60" key={row.hour}><td className="py-1">{label(row.hour)}</td><td className="py-1 text-right font-bold tabular-nums">{format(row.value)}</td></tr>)}</tbody></table></details>
    </>}</Card>;
}
