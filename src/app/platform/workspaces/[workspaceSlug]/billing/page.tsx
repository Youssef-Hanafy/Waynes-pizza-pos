import type { Metadata } from "next";
import { recordBillingPayment, saveInvoice, saveSubscription } from "../../../actions";
import { Flash, first, serviceName, when } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { billingIntervals, paymentMethodLabels, paymentMethods, type PlatformInvoice } from "@/lib/platform/billing";
import { formatMoney } from "@/lib/platform/money";
import { getPlatformWorkspace, getPlatformWorkspaceBilling } from "@/lib/platform/queries";

export const metadata: Metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

const select = "min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal";
const invoiceTone = { draft: "neutral", open: "warn", paid: "ok", void: "neutral" } as const;
const perInterval = { monthly: "month", quarterly: "quarter", yearly: "year" } as const;

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "alert" | "warn" }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-wayne-muted">{label}</p>
      <strong className={`mt-1 block text-3xl ${tone === "alert" ? "text-wayne-alert" : tone === "warn" ? "text-wayne-warn" : ""}`}>{value}</strong>
      {note ? <p className="mt-1 text-xs text-wayne-muted">{note}</p> : null}
    </Card>
  );
}

function InvoiceLines({ invoice }: { invoice?: PlatformInvoice }) {
  const rows = [...(invoice?.items ?? []), ...Array.from({ length: Math.max(1, 5 - (invoice?.items.length ?? 0)) }, () => null)].slice(0, 5);
  return (
    <div className="grid gap-2 md:col-span-3">
      <p className="text-sm font-bold">Lines {invoice ? "(saving replaces all lines)" : "(optional; agreements can be added automatically)"}</p>
      {rows.map((item, index) => (
        <div className="grid gap-2 md:grid-cols-[10rem_1fr_6rem_9rem]" key={item?.id ?? `new-${index}`}>
          <select aria-label={`Line ${index + 1} kind`} className={select} defaultValue={item?.kind ?? "service"} name={`item_${index}_kind`}>
            <option value="service">Service</option><option value="subscription">Agreement</option><option value="setup">Setup / one-off</option><option value="adjustment">Credit / adjustment</option>
          </select>
          <input aria-label={`Line ${index + 1} description`} className={select} defaultValue={item?.description ?? ""} maxLength={300} name={`item_${index}_description`} placeholder="Description" />
          <input aria-label={`Line ${index + 1} quantity`} className={select} defaultValue={item?.quantity ?? 1} min={1} name={`item_${index}_quantity`} type="number" />
          <input aria-label={`Line ${index + 1} unit price`} className={select} defaultValue={item ? (item.unit_price_cents / 100).toFixed(2) : ""} inputMode="decimal" name={`item_${index}_amount`} placeholder="$ each" />
        </div>
      ))}
    </div>
  );
}

/**
 * Billing tab (§11.3 Billing, §23).  What this business pays Hanafy: its
 * agreement(s), invoices and payments.  Manual v1 — nothing is charged
 * automatically.  Not the restaurant's own customer payments.
 */
export default async function PlatformWorkspaceBillingPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const [workspace, data] = await Promise.all([getPlatformWorkspace(workspaceSlug), getPlatformWorkspaceBilling(workspaceSlug)]);
  const tz = workspace.timezone;
  const { totals } = data;
  const live = data.subscriptions.filter((subscription) => subscription.status !== "cancelled");
  const hidden = <><input name="workspace" type="hidden" value={workspace.slug} /><input name="tab" type="hidden" value="billing" /></>;

  return (
    <div className="mt-6">
      <Flash error={first(query.error)} saved={first(query.saved)} />
      <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Monthly recurring" note={totals.agreement ? `${totals.agreement.label}${totals.agreement.plan_name ? ` · ${totals.agreement.plan_name}` : ""}` : "No agreement recorded yet"} value={formatMoney(totals.monthly_recurring_cents)} />
        <Stat label="Unpaid invoices" note={`${totals.open_invoices} open`} tone={totals.open_balance_cents ? "warn" : undefined} value={formatMoney(totals.open_balance_cents)} />
        <Stat label="Overdue" note={`${totals.overdue_invoices} invoice${totals.overdue_invoices === 1 ? "" : "s"}`} tone={totals.overdue_balance_cents ? "alert" : undefined} value={formatMoney(totals.overdue_balance_cents)} />
        <Stat label="Owed on equipment" note={`${totals.equipment_assets} item${totals.equipment_assets === 1 ? "" : "s"} supplied by Hanafy`} tone={totals.equipment_balance_cents ? "warn" : undefined} value={formatMoney(totals.equipment_balance_cents)} />
      </div>
      <p className="mt-3 text-sm text-wayne-muted">Services on: {workspace.services.length ? workspace.services.map(serviceName).join(", ") : "none"}. This is Hanafy&apos;s bill to {workspace.name}, not {workspace.name}&apos;s own customer payments.</p>

      <h2 className="mt-8 text-2xl font-black">Agreement</h2>
      <div className="mt-3 grid gap-3">
        {data.subscriptions.map((subscription) => (
          <Card className="p-5" key={subscription.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <strong className="text-lg">{subscription.label}</strong>
                <span className="ml-2 text-sm text-wayne-muted">{subscription.kind === "base" ? "Base agreement" : "Add-on"}{subscription.plan_name ? ` · ${subscription.plan_name}` : " · custom"}</span>
              </div>
              <Badge tone={subscription.status === "active" ? "ok" : subscription.status === "cancelled" ? "neutral" : "warn"}>{subscription.status}</Badge>
            </div>
            <p className="mt-2"><strong>{formatMoney(subscription.price_cents)}</strong> per {perInterval[subscription.billing_interval]}{subscription.billing_interval !== "monthly" ? ` (${formatMoney(subscription.monthly_equivalent_cents)} a month)` : ""} · from {subscription.start_date}{subscription.end_date ? ` to ${subscription.end_date}` : ""}</p>
            {subscription.custom_terms ? <p className="mt-1 text-sm text-wayne-muted">{subscription.custom_terms}</p> : null}
            {data.can_manage && subscription.status !== "cancelled" ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-bold">Change</summary>
                <form action={saveSubscription} className="mt-3 grid gap-4 md:grid-cols-3">
                  {hidden}<input name="id" type="hidden" value={subscription.id} />
                  <Input defaultValue={subscription.label} label="Name" name="label" />
                  <Input defaultValue={(subscription.price_cents / 100).toFixed(2)} inputMode="decimal" label="Price ($ per interval)" name="price" />
                  <label className="grid gap-1.5 text-sm font-bold">Interval
                    <select className={select} defaultValue={subscription.billing_interval} name="billing_interval">{billingIntervals.map((value) => <option key={value} value={value}>{value}</option>)}</select>
                  </label>
                  <label className="grid gap-1.5 text-sm font-bold">Status
                    <select className={select} defaultValue={subscription.status} name="status"><option value="trial">Trial</option><option value="active">Active</option><option value="paused">Paused</option><option value="cancelled">Cancelled</option></select>
                  </label>
                  <Input defaultValue={subscription.end_date ?? ""} label="End date" name="end_date" type="date" />
                  <Input defaultValue={subscription.custom_terms ?? ""} label="Terms / notes" name="custom_terms" />
                  <Input label="Reason" minLength={5} name="reason" required />
                  <div className="md:col-span-3"><Button variant="brand">Save agreement</Button></div>
                </form>
              </details>
            ) : null}
          </Card>
        ))}
        {data.subscriptions.length === 0 ? <Card className="p-5 text-wayne-muted">No agreement recorded. Add what {workspace.name} actually pays Hanafy below.</Card> : null}
      </div>

      {data.can_manage ? (
        <Card className="mt-4 p-5">
          <h3 className="text-lg font-black">{live.some((subscription) => subscription.kind === "base") ? "Add an add-on" : "Record the agreement"}</h3>
          <form action={saveSubscription} className="mt-3 grid gap-4 md:grid-cols-3">
            {hidden}
            <label className="grid gap-1.5 text-sm font-bold">Type
              <select className={select} defaultValue={live.some((subscription) => subscription.kind === "base") ? "addon" : "base"} name="kind"><option value="base">Base agreement</option><option value="addon">Add-on</option></select>
            </label>
            <label className="grid gap-1.5 text-sm font-bold">Plan
              <select className={select} defaultValue="" name="plan_id"><option value="">Custom (no standard plan)</option>{data.plans.filter((plan) => plan.active).map((plan) => <option key={plan.id} value={plan.id}>{plan.name}{plan.base_monthly_price_cents !== null ? ` (${formatMoney(plan.base_monthly_price_cents)}/mo)` : ""}</option>)}</select>
            </label>
            <Input label="Name" maxLength={120} name="label" placeholder="Custom agreement" />
            <Input inputMode="decimal" label="Price ($ per interval)" name="price" placeholder="249.00" required />
            <label className="grid gap-1.5 text-sm font-bold">Interval
              <select className={select} defaultValue="monthly" name="billing_interval">{billingIntervals.map((value) => <option key={value} value={value}>{value}</option>)}</select>
            </label>
            <Input label="Starts" name="start_date" type="date" />
            <Input className="md:col-span-2" label="Terms / notes" maxLength={2000} name="custom_terms" placeholder="What was agreed" />
            <Input label="Reason" minLength={5} name="reason" required />
            <div className="md:col-span-3"><Button variant="brand">Save</Button></div>
          </form>
        </Card>
      ) : null}

      <h2 className="mt-10 text-2xl font-black">Invoices</h2>
      <div className="mt-3 grid gap-3">
        {data.invoices.map((invoice) => (
          <Card className="p-5" key={invoice.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <strong className="text-lg">{invoice.invoice_number}</strong>
                <span className="ml-2 text-sm text-wayne-muted">
                  {invoice.issue_date ? `Issued ${invoice.issue_date} · due ${invoice.due_date}` : "Draft"}{invoice.period_start ? ` · for ${invoice.period_start} to ${invoice.period_end ?? "…"}` : ""}
                </span>
              </div>
              <div className="flex gap-2">
                {invoice.overdue ? <Badge tone="alert">Overdue</Badge> : null}
                <Badge tone={invoiceTone[invoice.status]}>{invoice.status === "open" ? "unpaid" : invoice.status}</Badge>
              </div>
            </div>
            <table className="mt-3 w-full text-left text-sm">
              <tbody>
                {invoice.items.map((item) => (
                  <tr className="border-t border-wayne-border/60" key={item.id}><td className="py-1.5">{item.description}</td><td className="text-right text-wayne-muted">{item.quantity > 1 ? `${item.quantity} × ${formatMoney(item.unit_price_cents)}` : ""}</td><td className="w-32 text-right">{formatMoney(item.amount_cents)}</td></tr>
                ))}
                <tr className="border-t border-wayne-border font-bold"><td className="py-1.5">Total</td><td /><td className="text-right">{formatMoney(invoice.total_cents)}</td></tr>
                {invoice.status === "open" || invoice.status === "paid" ? (
                  <>
                    <tr><td className="py-1">Paid</td><td /><td className="text-right">{formatMoney(invoice.paid_cents)}</td></tr>
                    <tr className="font-bold"><td className="py-1">Still owed</td><td /><td className="text-right">{formatMoney(invoice.balance_due_cents)}</td></tr>
                  </>
                ) : null}
              </tbody>
            </table>
            {invoice.payments.length ? (
              <ul className="mt-3 grid gap-1 text-sm">
                {invoice.payments.map((payment) => (
                  <li className="flex flex-wrap items-center gap-2" key={payment.id}>
                    <span className={payment.voided_at ? "line-through text-wayne-muted" : ""}>{formatMoney(payment.amount_cents)} · {paymentMethodLabels[payment.method]} · {payment.paid_on}{payment.reference ? ` · ${payment.reference}` : ""}</span>
                    {payment.voided_at ? <span className="text-wayne-muted">voided: {payment.void_reason}</span> : data.can_manage ? (
                      <form action={recordBillingPayment} className="flex items-center gap-2">
                        {hidden}<input name="target" type="hidden" value="invoice" /><input name="void_payment_id" type="hidden" value={payment.id} />
                        <input aria-label="Reason to void" className="min-h-9 rounded-lg border border-wayne-border px-2" minLength={5} name="reason" placeholder="Reason to void" required />
                        <Button size="sm" variant="ghost">Void</Button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {invoice.void_reason ? <p className="mt-2 text-sm text-wayne-muted">Voided {when(invoice.voided_at, tz)}: {invoice.void_reason}</p> : null}
            {invoice.notes ? <p className="mt-2 text-sm text-wayne-muted">{invoice.notes}</p> : null}

            {data.can_manage ? (
              <div className="mt-4 grid gap-3">
                {invoice.status === "draft" ? (
                  <>
                    <details>
                      <summary className="cursor-pointer text-sm font-bold">Edit lines</summary>
                      <form action={saveInvoice} className="mt-3 grid gap-4 md:grid-cols-3">
                        {hidden}<input name="id" type="hidden" value={invoice.id} /><input name="action" type="hidden" value="update" />
                        <InvoiceLines invoice={invoice} />
                        <Input defaultValue={invoice.notes ?? ""} label="Notes" name="notes" />
                        <Input label="Reason" minLength={5} name="reason" required />
                        <div className="md:col-span-3"><Button variant="secondary">Save draft</Button></div>
                      </form>
                    </details>
                    <form action={saveInvoice} className="flex flex-wrap items-end gap-3">
                      {hidden}<input name="id" type="hidden" value={invoice.id} /><input name="action" type="hidden" value="issue" />
                      <Input label="Issue date" name="issue_date" type="date" />
                      <Input label="Due date" name="due_date" type="date" />
                      <Input label="Reason" minLength={5} name="reason" placeholder="Sent to the owner" required />
                      <Button variant="brand">Issue invoice</Button>
                    </form>
                  </>
                ) : null}
                {invoice.status === "open" ? (
                  <form action={recordBillingPayment} className="grid gap-3 md:grid-cols-6 md:items-end">
                    {hidden}<input name="target" type="hidden" value="invoice" /><input name="target_id" type="hidden" value={invoice.id} />
                    <Input defaultValue={(invoice.balance_due_cents / 100).toFixed(2)} inputMode="decimal" label="Amount paid ($)" name="amount" required />
                    <label className="grid gap-1.5 text-sm font-bold">How
                      <select className={select} defaultValue="check" name="method">{paymentMethods.map((method) => <option key={method} value={method}>{paymentMethodLabels[method]}</option>)}</select>
                    </label>
                    <Input label="Paid on" name="paid_on" type="date" />
                    <Input label="Check # / reference" maxLength={120} name="reference" />
                    <Input label="Reason" minLength={5} name="reason" placeholder="Payment received" required />
                    <Button variant="brand">Record payment</Button>
                  </form>
                ) : null}
                {invoice.status === "draft" || (invoice.status === "open" && invoice.paid_cents === 0) ? (
                  <form action={saveInvoice} className="flex flex-wrap items-end gap-2">
                    {hidden}<input name="id" type="hidden" value={invoice.id} /><input name="action" type="hidden" value="void" />
                    <Input label={invoice.status === "draft" ? "Reason to discard" : "Reason to void"} minLength={5} name="reason" required />
                    <Button size="sm" variant="ghost">{invoice.status === "draft" ? "Discard draft" : "Void invoice"}</Button>
                  </form>
                ) : null}
              </div>
            ) : null}
          </Card>
        ))}
        {data.invoices.length === 0 ? <Card className="p-5 text-wayne-muted">No invoices yet.</Card> : null}
      </div>

      {data.can_manage ? (
        <Card className="mt-4 p-5">
          <h3 className="text-lg font-black">New invoice</h3>
          <p className="mt-1 text-sm text-wayne-muted">Starts as a draft. Nothing is sent or charged automatically; issue it when you send it to the owner, then record payments as they arrive.</p>
          <form action={saveInvoice} className="mt-3 grid gap-4 md:grid-cols-3">
            {hidden}<input name="action" type="hidden" value="create" />
            <Input label="Period start" name="period_start" type="date" />
            <Input label="Period end" name="period_end" type="date" />
            <label className="flex items-center gap-2 self-end pb-3 text-sm font-bold"><input defaultChecked name="include_agreements" type="checkbox" value="yes" /> Add this period&apos;s agreement lines</label>
            <InvoiceLines />
            <Input label="Notes" maxLength={2000} name="notes" />
            <Input label="Reason" minLength={5} name="reason" placeholder="Monthly invoice" required />
            <div className="md:col-span-3"><Button variant="brand">Create draft</Button></div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
