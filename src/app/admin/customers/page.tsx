import Link from "next/link";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/access";
import { getStoreSettings } from "@/lib/content/queries";
import { getCustomers, getCustomerSegments } from "@/lib/customers/queries";
import { formatCents } from "@/lib/menu/schemas";
import { formatAdminDateTime } from "@/lib/orders/admin-format";

export const dynamic = "force-dynamic";
const filtersSchema = z.object({ q: z.string().trim().max(100).catch(""), segment: z.uuid().or(z.literal("")).catch(""), page: z.coerce.number().int().min(1).catch(1) });
export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("customers.view", "/admin/customers");
  const raw = await searchParams; const filters = filtersSchema.parse(Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value ?? ""])));
  const [settings, segments, result] = await Promise.all([getStoreSettings(), getCustomerSegments(), getCustomers({ search: filters.q, segmentId: filters.segment, page: filters.page })]);
  return <main className="mx-auto max-w-6xl px-5 py-10"><p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Customer intelligence</p><h1 className="mt-3 text-4xl font-black">Customers</h1><p className="mt-3 text-wayne-muted">Metrics are reproducible from qualifying orders; segment membership is evaluated server-side.</p><Card className="mt-8 p-5"><form className="grid gap-4 md:grid-cols-3" method="get"><Input defaultValue={filters.q} label="Name, phone, or email" name="q" /><label className="grid gap-2 text-sm font-semibold">Current segment<select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3 font-normal" defaultValue={filters.segment} name="segment"><option value="">All customers</option>{segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name}</option>)}</select></label><div className="flex items-end gap-3"><Button type="submit">Apply filters</Button><Button asChild variant="secondary"><Link href="/admin/customers">Clear</Link></Button></div></form></Card><div className="mt-7 flex justify-between"><h2 className="text-2xl font-black">{result.total_count} customer{result.total_count === 1 ? "" : "s"}</h2><Button asChild variant="secondary"><Link href="/admin/segments">Manage segments</Link></Button></div><div className="mt-4 grid gap-3">{result.customers.length ? result.customers.map((customer) => <Link href={`/admin/customers/${customer.id}`} key={customer.id}><Card className="grid gap-3 p-5 transition hover:border-wayne-red md:grid-cols-[1.2fr_1fr_1fr_auto]"><div><strong className="text-lg">{customer.first_name} {customer.last_name}</strong><p className="text-sm text-wayne-muted">{customer.phone_normalized}{customer.email_normalized ? ` · ${customer.email_normalized}` : ""}</p></div><div><strong>{customer.order_count} orders · {formatCents(customer.lifetime_spend_cents)}</strong><p className="text-sm text-wayne-muted">Last: {formatAdminDateTime(customer.last_order_at, settings.timezone)}</p></div><div className="flex flex-wrap gap-1">{customer.segments.map((segment) => <Badge key={segment.id}>{segment.name}</Badge>)}{customer.sms_marketing_opt_in ? <Badge className="bg-wayne-ok text-white">SMS</Badge> : null}{customer.email_marketing_opt_in ? <Badge className="bg-wayne-info text-white">Email</Badge> : null}</div><strong className="self-center text-wayne-red">Open →</strong></Card></Link>) : <Card className="p-9 text-center text-wayne-muted">No customers match these filters.</Card>}</div></main>;
}
