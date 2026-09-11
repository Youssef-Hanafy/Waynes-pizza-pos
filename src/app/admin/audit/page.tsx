import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/access";
import { auditPageSize, getAuditLog, getRecentServerErrors, type AuditEntry } from "@/lib/audit/queries";
import { getStoreSettings } from "@/lib/content/queries";
import { formatAdminDateTime } from "@/lib/orders/admin-format";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

const areas: Array<[string, string]> = [
  ["", "Everything"], ["orders", "Order cancellations"], ["order_discounts", "Manual discounts"], ["refunds", "Refunds"],
  ["menu_items", "Menu items"], ["menu_categories", "Menu categories"], ["menu_item_variants", "Item sizes"], ["modifier_groups", "Modifier groups"], ["modifier_choices", "Modifier choices"],
  ["store_settings", "Business & tax settings"], ["store_special_hours", "Special hours"], ["promotions", "Promotions"],
  ["profiles", "Staff & roles"], ["role_permissions", "Role permissions"], ["integration_destinations", "Hanafy settings"], ["integration_outbox", "Event replays"], ["customer_segments", "Segments"],
];
const filtersSchema = z.object({
  entity: z.enum(areas.map(([value]) => value) as [string, ...string[]]).catch(""),
  q: z.string().trim().max(80).regex(/^[^,()%]*$/).catch(""),
  page: z.coerce.number().int().min(1).max(1000).catch(1),
  view: z.enum(["log", "errors"]).catch("log"),
});

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("audit.view", "/admin/audit");
  const raw = await searchParams;
  const filters = filtersSchema.parse(Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])));
  const settings = await getStoreSettings();
  const link = (next: Partial<typeof filters>) => { const params = new URLSearchParams(Object.entries({ ...filters, ...next }).filter(([, value]) => value !== "" && value !== 1 && value !== "log").map(([key, value]) => [key, String(value)])); const text = params.toString(); return `/admin/audit${text ? `?${text}` : ""}`; };

  return <main className="mx-auto max-w-6xl px-5 py-10">
    <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Accountability</p>
    <h1 className="mt-3 text-4xl font-black">Audit log</h1>
    <p className="mt-3 max-w-3xl text-wayne-muted">Every menu, price, tax/settings, promotion, staff-role, integration, refund, discount, cancellation, and replay action — who did it, when, and exactly what changed. Entries cannot be edited or deleted.</p>
    <div className="mt-6 flex flex-wrap gap-2"><Button asChild variant={filters.view === "log" ? "primary" : "secondary"}><Link href={link({ view: "log", page: 1 })}>Change history</Link></Button><Button asChild variant={filters.view === "errors" ? "primary" : "secondary"}><Link href={link({ view: "errors", page: 1 })}>Server errors</Link></Button></div>
    {filters.view === "errors" ? <ServerErrors timeZone={settings.timezone} /> : <ChangeHistory filters={filters} link={link} timeZone={settings.timezone} />}
  </main>;
}

async function ChangeHistory({ filters, link, timeZone }: { filters: z.infer<typeof filtersSchema>; link: (next: Partial<z.infer<typeof filtersSchema>>) => string; timeZone: string }) {
  const { entries, total, roleNames } = await getAuditLog({ entity: filters.entity || undefined, q: filters.q || undefined, page: filters.page });
  const pages = Math.max(1, Math.ceil(total / auditPageSize));
  return <>
    <Card className="mt-6 p-5"><form className="flex flex-wrap items-end gap-4" method="get"><label className="grid gap-2 text-sm font-bold">Area<select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3 font-normal" defaultValue={filters.entity} name="entity">{areas.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="grid gap-2 text-sm font-bold">Search summary or staff name<input className="min-h-11 rounded-lg border border-wayne-border px-3 font-normal" defaultValue={filters.q} maxLength={80} name="q" /></label><Button>Filter</Button><Button asChild variant="secondary"><Link href="/admin/audit">Clear</Link></Button></form></Card>
    <p className="mt-4 text-sm text-wayne-muted">{total} entr{total === 1 ? "y" : "ies"} · page {filters.page} of {pages}</p>
    <div className="mt-3 grid gap-3">{entries.map((entry) => <Card className="p-4" key={entry.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><strong>{entry.summary || entry.action}</strong><p className="text-sm text-wayne-muted">{entry.actor_name} · {formatAdminDateTime(entry.occurred_at, timeZone)} · <code>{entry.action}</code></p></div>{entry.entity_type === "orders" && entry.entity_id ? <Link className="text-sm font-bold underline" href={`/admin/orders/${entry.entity_id}`}>Open order</Link> : entry.entity_type === "order_discounts" && entry.entity_id ? <Link className="text-sm font-bold underline" href={`/admin/orders/${entry.entity_id}`}>Open order</Link> : null}</div><Changes entry={entry} roleNames={roleNames} /></Card>)}
      {!entries.length ? <Card className="p-8 text-center text-wayne-muted">No audit entries match these filters.</Card> : null}</div>
    <div className="mt-5 flex gap-3">{filters.page > 1 ? <Button asChild variant="secondary"><Link href={link({ page: filters.page - 1 })}>← Newer</Link></Button> : null}{filters.page < pages ? <Button asChild variant="secondary"><Link href={link({ page: filters.page + 1 })}>Older →</Link></Button> : null}</div>
  </>;
}

function Changes({ entry, roleNames }: { entry: AuditEntry; roleNames: Record<string, string> }) {
  const rows = Object.entries(entry.changes);
  if (!rows.length) return null;
  const show = (field: string, value: unknown) => { if (value === null || value === undefined) return "—"; if (field === "role_id" && typeof value === "string") return roleNames[value] ?? value; if (field.endsWith("_cents") && typeof value === "number") return `$${(value / 100).toFixed(2)}`; if (field === "tax_rate_basis_points" && typeof value === "number") return `${(value / 100).toFixed(2)}%`; return typeof value === "string" ? value : JSON.stringify(value); };
  return <details className="mt-3"><summary className="cursor-pointer text-sm font-bold">{rows.length} field{rows.length === 1 ? "" : "s"} changed</summary><div className="mt-2 overflow-x-auto"><table className="w-full min-w-120 text-left text-sm"><thead><tr className="border-b border-wayne-border"><th className="py-2 pr-3">Field</th><th className="py-2 pr-3">Before</th><th className="py-2">After</th></tr></thead><tbody>{rows.map(([field, change]) => <tr className="border-b border-wayne-border/60 align-top last:border-0" key={field}><td className="py-2 pr-3 font-mono text-xs">{field}</td><td className="max-w-xs break-words py-2 pr-3 text-wayne-muted">{show(field, change.from)}</td><td className="max-w-xs break-words py-2">{show(field, change.to)}</td></tr>)}</tbody></table></div></details>;
}

async function ServerErrors({ timeZone }: { timeZone: string }) {
  const { errors, unavailable } = await getRecentServerErrors();
  return <div className="mt-6"><p className="text-sm text-wayne-muted">The 25 most recent server-side errors (kept 90 days). Query strings and credentials are removed before storage. Full details are in the hosting provider&apos;s logs — search for the digest.</p>
    {unavailable ? <p className="mt-4 rounded-xl bg-amber-50 p-4">Error history is unavailable. Check that the database migrations are applied.</p> : null}
    <div className="mt-4 grid gap-3">{errors.map((error) => <Card className="p-4" key={error.id}><strong className="break-words">{error.message || "Unknown error"}</strong><p className="mt-1 text-sm text-wayne-muted">{formatAdminDateTime(error.occurred_at, timeZone)} · {error.method} {error.request_path} · {error.route_type}{error.digest ? ` · digest ${error.digest}` : ""}</p></Card>)}
      {!errors.length && !unavailable ? <Card className="p-8 text-center text-wayne-muted">No server errors recorded.</Card> : null}</div></div>;
}
