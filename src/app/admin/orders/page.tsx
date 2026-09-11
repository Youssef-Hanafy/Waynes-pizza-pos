import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AutoRefresh } from "@/components/ops/auto-refresh";
import { requirePermission } from "@/lib/auth/access";
import { getStoreSettings } from "@/lib/content/queries";
import { formatCents } from "@/lib/menu/schemas";
import { formatAdminDateTime, titleCase } from "@/lib/orders/admin-format";
import { getAdminOrders } from "@/lib/orders/admin-queries";

export const metadata: Metadata = { title: "Order history" };
export const dynamic = "force-dynamic";

const filtersSchema = z.object({
  q: z.string().trim().max(100).catch(""),
  from: z.iso.date().or(z.literal("")).catch(""),
  to: z.iso.date().or(z.literal("")).catch(""),
  fulfillment: z.enum(["", "pickup", "delivery"]).catch(""),
  source: z.enum(["", "online", "pos", "phone", "admin"]).catch(""),
  status: z.enum(["", "placed", "accepted", "in_kitchen", "ready", "out_for_delivery", "completed", "cancelled"]).catch(""),
  payment: z.enum(["", "test_manual", "cash", "card"]).catch(""),
  page: z.coerce.number().int().min(1).catch(1),
});

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("orders.view", "/admin/orders");
  const raw = await searchParams;
  const filters = filtersSchema.parse(Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value ?? ""])));
  const [result, settings] = await Promise.all([
    getAdminOrders({ search: filters.q, from: filters.from, through: filters.to, fulfillment: filters.fulfillment, source: filters.source, status: filters.status, payment: filters.payment, page: filters.page }),
    getStoreSettings(),
  ]);

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Orders</p>
          <h1 className="mt-3 text-4xl font-black">Order history</h1>
          <div className="mt-2"><AutoRefresh intervalMs={30_000} live /></div>
          <p className="mt-3 text-wayne-muted">Find an order by date, order number, customer name, or phone number.</p>
        </div>
        <Button asChild variant="secondary"><Link href="/admin/calendar">Monthly calendar</Link></Button>
      </div>

      <Card className="mt-8 p-5">
        <form className="grid gap-4 md:grid-cols-4" method="get">
          <div className="md:col-span-2"><Input defaultValue={filters.q} label="Order, name, or phone" name="q" placeholder="WP-1001 or 508-555-0101" /></div>
          <Input defaultValue={filters.from} label="From date" name="from" type="date" />
          <Input defaultValue={filters.to} label="Through date" name="to" type="date" />
          <FilterSelect label="Fulfillment" name="fulfillment" value={filters.fulfillment} options={["pickup", "delivery"]} />
          <FilterSelect label="Source" name="source" value={filters.source} options={["online", "pos", "phone", "admin"]} />
          <FilterSelect label="Status" name="status" value={filters.status} options={["placed", "accepted", "in_kitchen", "ready", "out_for_delivery", "completed", "cancelled"]} />
          <FilterSelect label="Payment" name="payment" value={filters.payment} options={["test_manual", "cash", "card"]} />
          <div className="flex flex-wrap gap-3 md:col-span-4">
            <Button type="submit">Apply filters</Button>
            <Button asChild variant="secondary"><Link href="/admin/orders">Clear</Link></Button>
          </div>
        </form>
      </Card>

      <div className="mt-7 flex items-center justify-between gap-4">
        <h2 className="text-2xl font-black">{result.total_count} order{result.total_count === 1 ? "" : "s"}</h2>
        {result.total_count > result.orders.length ? <p className="text-sm text-wayne-muted">Showing {((filters.page - 1) * 50) + 1}–{Math.min(filters.page * 50, result.total_count)}</p> : null}
      </div>
      <div className="mt-4 grid gap-3">
        {result.orders.length ? result.orders.map((order) => (
          <Link aria-label={`Open order ${order.order_number}`} href={`/admin/orders/${order.id}`} key={order.id}>
            <Card className="grid gap-4 p-5 transition hover:-translate-y-0.5 hover:border-wayne-red sm:grid-cols-[1.1fr_1.2fr_0.8fr_auto] sm:items-center">
              <div><strong className="text-lg">{order.order_number}</strong><p className="text-sm text-wayne-muted">{formatAdminDateTime(order.placed_at, settings.timezone)}</p></div>
              <div><strong>{order.customer_name_snapshot}</strong><p className="text-sm text-wayne-muted">{order.customer_phone_snapshot}</p></div>
              <div className="flex flex-wrap gap-2"><Badge>{titleCase(order.status)}</Badge><Badge className="bg-stone-700">{titleCase(order.fulfillment_type)}</Badge><Badge className="bg-blue-700">{titleCase(order.source)}</Badge><Badge className="bg-emerald-700">{titleCase(order.payment_method)}</Badge></div>
              <strong className="text-lg sm:text-right">{formatCents(order.total_cents)}</strong>
            </Card>
          </Link>
        )) : <Card className="p-9 text-center"><h2 className="text-2xl font-black">No matching orders</h2><p className="mt-2 text-wayne-muted">Try clearing or broadening the filters.</p></Card>}
      </div>
      {result.total_count > 50 ? <nav aria-label="Order pagination" className="mt-7 flex items-center justify-between gap-4"><Button asChild disabled={filters.page === 1} variant="secondary"><Link href={pageHref(filters, filters.page - 1)}>← Newer</Link></Button><p className="text-sm font-bold">Page {filters.page} of {Math.ceil(result.total_count / 50)}</p><Button asChild disabled={filters.page * 50 >= result.total_count} variant="secondary"><Link href={pageHref(filters, filters.page + 1)}>Older →</Link></Button></nav> : null}
    </main>
  );
}

function pageHref(filters: z.infer<typeof filtersSchema>, page: number) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value && key !== "page") params.set(key === "q" ? "q" : key, String(value));
  params.set("page", String(Math.max(1, page)));
  return `/admin/orders?${params.toString()}`;
}

function FilterSelect({ label, name, value, options }: { label: string; name: string; value: string; options: string[] }) {
  return <label className="grid gap-2 text-sm font-semibold">{label}<select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3 font-normal" defaultValue={value} name={name}><option value="">All</option>{options.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}</select></label>;
}
