import type { Metadata } from "next";
import Link from "next/link";
import { savePlan } from "../actions";
import { Flash, first, serviceName } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/platform/money";
import { getPlatformBillingOverview } from "@/lib/platform/queries";

export const metadata: Metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

/**
 * Platform Admin → Billing (§23): every business's bill to Hanafy in one
 * place, overdue invoices, and the standard plans.  Manual v1.
 */
export default async function PlatformBillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [data, query] = await Promise.all([getPlatformBillingOverview(), searchParams]);
  const sum = (key: "monthly_recurring_cents" | "open_balance_cents" | "overdue_balance_cents" | "equipment_balance_cents") => data.workspaces.reduce((total, row) => total + row[key], 0);

  return (
    <main className="mx-auto max-w-7xl px-5 py-10">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">Hanafy Platform</p>
      <h1 className="mt-3 text-4xl font-black">Billing</h1>
      <p className="mt-2 max-w-3xl text-wayne-muted">What businesses owe Hanafy Media for software and equipment. Separate from each business&apos;s own customer payments. Nothing is charged automatically.</p>
      <Flash error={first(query.error)} saved={first(query.saved)} />

      <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {([["Monthly recurring", "monthly_recurring_cents"], ["Unpaid invoices", "open_balance_cents"], ["Overdue", "overdue_balance_cents"], ["Owed on equipment", "equipment_balance_cents"]] as const).map(([label, key]) => (
          <Card className="p-5" key={key}>
            <p className="text-sm text-wayne-muted">{label}</p>
            <strong className={`mt-1 block text-3xl ${key === "overdue_balance_cents" && sum(key) ? "text-wayne-alert" : ""}`}>{formatMoney(sum(key))}</strong>
          </Card>
        ))}
      </div>

      <h2 className="mt-10 text-2xl font-black">Businesses</h2>
      <div className="mt-4 overflow-x-auto rounded-2xl border border-wayne-border bg-wayne-surface">
        <table className="w-full min-w-180 text-left text-sm">
          <thead className="border-b border-wayne-border text-xs uppercase tracking-wider text-wayne-muted">
            <tr><th className="px-4 py-3">Business</th><th className="px-4 py-3">Agreement</th><th className="px-4 py-3 text-right">Monthly</th><th className="px-4 py-3 text-right">Unpaid</th><th className="px-4 py-3 text-right">Overdue</th><th className="px-4 py-3 text-right">Equipment</th></tr>
          </thead>
          <tbody>
            {data.workspaces.map((row) => (
              <tr className="border-b border-wayne-border/60 last:border-0" key={row.slug}>
                <td className="px-4 py-3"><Link className="font-bold hover:underline" href={`/platform/workspaces/${row.slug}/billing`}>{row.name}</Link> <span className="text-wayne-muted">· {row.status}</span></td>
                <td className="px-4 py-3">{row.agreement ? `${row.agreement.label} (${row.agreement.status})` : <Badge tone="warn">None recorded</Badge>}</td>
                <td className="px-4 py-3 text-right">{formatMoney(row.monthly_recurring_cents)}</td>
                <td className="px-4 py-3 text-right">{formatMoney(row.open_balance_cents)}</td>
                <td className={`px-4 py-3 text-right ${row.overdue_balance_cents ? "font-bold text-wayne-alert" : ""}`}>{formatMoney(row.overdue_balance_cents)}</td>
                <td className="px-4 py-3 text-right"><Link className="hover:underline" href={`/platform/workspaces/${row.slug}/equipment`}>{formatMoney(row.equipment_balance_cents)}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-2xl font-black">Overdue invoices</h2>
      <div className="mt-3 grid gap-2">
        {data.overdue.map((invoice) => (
          <Card className="flex flex-wrap items-center justify-between gap-3 p-4" key={invoice.id}>
            <span><strong>{invoice.workspace_name}</strong> · {invoice.invoice_number} · due {invoice.due_date}</span>
            <span className="flex items-center gap-3"><strong className="text-wayne-alert">{formatMoney(invoice.balance_due_cents)}</strong><Link className="text-sm font-bold underline" href={`/platform/workspaces/${invoice.workspace_slug}/billing`}>Open</Link></span>
          </Card>
        ))}
        {data.overdue.length === 0 ? <Card className="p-5 text-wayne-muted">Nothing is overdue.</Card> : null}
      </div>

      <h2 className="mt-10 text-2xl font-black">Plans</h2>
      <p className="mt-1 text-sm text-wayne-muted">Optional standard packages. Any business can instead have a custom agreement.</p>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {data.plans.map((plan) => (
          <Card className="p-5" key={plan.id}>
            <div className="flex items-center justify-between gap-3">
              <strong className="text-lg">{plan.name}</strong>
              <Badge tone={plan.active ? "ok" : "neutral"}>{plan.active ? "offered" : "retired"}</Badge>
            </div>
            <p className="mt-1 text-sm text-wayne-muted"><code>{plan.code}</code> · {plan.base_monthly_price_cents === null ? "price agreed per client" : `${formatMoney(plan.base_monthly_price_cents)} a month`} · {plan.subscribers} business{plan.subscribers === 1 ? "" : "es"}</p>
            {plan.description ? <p className="mt-2 text-sm">{plan.description}</p> : null}
            {plan.services.length ? <p className="mt-2 text-sm">Includes: {plan.services.map(serviceName).join(", ")}</p> : null}
            {data.can_manage ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-bold">Change</summary>
                <form action={savePlan} className="mt-3 grid gap-3">
                  <input name="id" type="hidden" value={plan.id} /><input name="services_present" type="hidden" value="yes" />
                  <Input defaultValue={plan.name} label="Name" name="name" />
                  <Input defaultValue={plan.base_monthly_price_cents === null ? "" : (plan.base_monthly_price_cents / 100).toFixed(2)} inputMode="decimal" label="Monthly price ($, blank = per client)" name="price" />
                  <Input defaultValue={plan.description} label="Description" name="description" />
                  <fieldset className="text-sm"><legend className="font-bold">Services included</legend>
                    <div className="mt-1 flex flex-wrap gap-3">{data.services.map((service) => <label className="flex items-center gap-1.5" key={service.code}><input defaultChecked={plan.services.includes(service.code)} name="services" type="checkbox" value={service.code} />{service.name}</label>)}</div>
                  </fieldset>
                  <label className="flex items-center gap-2 text-sm font-bold"><select className="min-h-9 rounded-lg border border-wayne-border px-2" defaultValue={plan.active ? "yes" : "no"} name="active"><option value="yes">Offered</option><option value="no">Retired</option></select></label>
                  <Input label="Reason" minLength={5} name="reason" required />
                  <Button variant="secondary">Save plan</Button>
                </form>
              </details>
            ) : null}
          </Card>
        ))}
      </div>
      {data.can_manage ? (
        <Card className="mt-4 p-5">
          <h3 className="text-lg font-black">New plan</h3>
          <form action={savePlan} className="mt-3 grid gap-3 md:grid-cols-3">
            <input name="services_present" type="hidden" value="yes" />
            <Input label="Code" name="code" placeholder="restaurant_growth" required />
            <Input label="Name" name="name" placeholder="Restaurant Growth" required />
            <Input inputMode="decimal" label="Monthly price ($, blank = per client)" name="price" />
            <Input className="md:col-span-3" label="Description" name="description" />
            <fieldset className="text-sm md:col-span-3"><legend className="font-bold">Services included</legend>
              <div className="mt-1 flex flex-wrap gap-3">{data.services.map((service) => <label className="flex items-center gap-1.5" key={service.code}><input name="services" type="checkbox" value={service.code} />{service.name}</label>)}</div>
            </fieldset>
            <Input label="Reason" minLength={5} name="reason" required />
            <div className="md:col-span-3"><Button variant="brand">Add plan</Button></div>
          </form>
        </Card>
      ) : null}
    </main>
  );
}
