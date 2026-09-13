import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/access";
import { getStoreSettings } from "@/lib/content/queries";
import { formatCents } from "@/lib/menu/schemas";
import { formatAdminDateTime } from "@/lib/orders/admin-format";
import { paymentSecretsPresent } from "@/lib/payments/config";
import { getPaymentConsole, getPaymentReconciliation } from "@/lib/payments/queries";
import type { PaymentConsole, PaymentReconciliation } from "@/lib/payments/schemas";
import { savePaymentSettings, savePaymentTerminal } from "./actions";

export const metadata: Metadata = { title: "Payments" };
export const dynamic = "force-dynamic";
const dateSchema = z.iso.date();
const single = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

function businessDate(timeZone: string, date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

type Search = { from?: string | string[]; to?: string | string[]; error?: string | string[]; saved?: string | string[] };

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requirePermission("payments.manage", "/admin/payments");
  const [settings, params] = await Promise.all([getStoreSettings(), searchParams]);
  const today = businessDate(settings.timezone);
  const rawFrom = single(params.from);
  const rawTo = single(params.to);
  const from = dateSchema.safeParse(rawFrom).success ? rawFrom! : today;
  const to = dateSchema.safeParse(rawTo).success && rawTo! >= from ? rawTo! : from;

  let paymentConsole: PaymentConsole | null = null;
  let consoleError = "";
  try { paymentConsole = await getPaymentConsole(); } catch { consoleError = "The payment console could not be loaded. Refresh to try again."; }
  let reconciliation: PaymentReconciliation | null = null;
  let reconciliationError = "";
  try { reconciliation = await getPaymentReconciliation(from, to); } catch { reconciliationError = "Reconciliation could not be loaded for this range."; }

  const secrets = paymentSecretsPresent();
  const error = single(params.error);
  const saved = single(params.saved);
  const live = Boolean(paymentConsole?.settings.online_card_enabled || paymentConsole?.settings.terminal_card_enabled);

  return <main className="mx-auto max-w-6xl px-5 py-10">
    <div className="flex flex-wrap items-end justify-between gap-5">
      <div>
        <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Payments</p>
        <h1 className="mt-3 text-4xl font-black">Card processing</h1>
        <p className="mt-3 max-w-3xl text-wayne-muted">Card payment stays completely off until the processor is configured here and switched on. Nothing on the storefront changes before that.</p>
      </div>
      <Button asChild variant="secondary"><Link href="/admin/reports">Reports</Link></Button>
    </div>

    {error ? <div className="mt-6 rounded-xl border border-wayne-alert/50 bg-wayne-alert-soft p-4 font-bold text-wayne-alert" role="alert">{error}</div> : null}
    {saved ? <div className="mt-6 rounded-xl border border-wayne-ok/50 bg-wayne-ok-soft p-4 font-bold text-wayne-ok" role="status">{saved}</div> : null}
    {consoleError ? <div className="mt-6 rounded-xl border border-wayne-warn/50 bg-wayne-warn-soft p-4 font-bold">{consoleError}</div> : null}

    <Card className="mt-8 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-black">Status</h2>
        <Badge className={live ? "bg-wayne-ok-soft text-wayne-ok" : "bg-wayne-cream-deep text-wayne-muted"}>{live ? "Card payment is live" : "Card payment is off"}</Badge>
      </div>
      <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Server credentials" value={secrets ? "Installed" : "Missing"} />
        <Metric label="Payments waiting" value={String(paymentConsole?.counts.pending_payments ?? 0)} />
        <Metric label="Failed in 24 hours" value={String(paymentConsole?.counts.failed_payments_24h ?? 0)} />
        <Metric label="Webhooks not verified" value={String(paymentConsole?.counts.unverified_webhooks ?? 0)} />
      </dl>
      {!secrets ? <p className="mt-5 rounded-xl border border-wayne-warn/50 bg-wayne-warn-soft p-4 text-sm font-bold">
        The processor access token and webhook signature key are not installed on this server. Add <code>SQUARE_ACCESS_TOKEN</code> and <code>SQUARE_WEBHOOK_SIGNATURE_KEY</code> to the environment, then redeploy. Until then a card can never be charged, whatever the switches below say.
      </p> : null}
    </Card>

    <Card className="mt-6 p-6">
      <h2 className="text-2xl font-black">Processor</h2>
      <p className="mt-2 text-sm text-wayne-muted">Only non-secret identifiers are stored here. The access token and signature key live in the server environment and are never sent to a browser.</p>
      <form action={savePaymentSettings} className="mt-5 grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-2 text-sm font-semibold" htmlFor="provider">Provider
            <select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3" defaultValue={paymentConsole?.settings.provider ?? "none"} id="provider" name="provider">
              <option value="none">Not configured</option>
              <option value="square">Square</option>
            </select>
          </label>
          <label className="grid gap-2 text-sm font-semibold" htmlFor="environment">Environment
            <select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3" defaultValue={paymentConsole?.settings.environment ?? "sandbox"} id="environment" name="environment">
              <option value="sandbox">Sandbox (test money)</option>
              <option value="production">Production (real money)</option>
            </select>
          </label>
          <Input defaultValue={paymentConsole?.settings.application_id ?? ""} label="Application ID" name="application_id" placeholder="sandbox-sq0idb-…" />
          <Input defaultValue={paymentConsole?.settings.location_id ?? ""} label="Location ID" name="location_id" placeholder="L4T2…" />
          <Input className="sm:col-span-2" defaultValue={paymentConsole?.settings.notification_url ?? ""} label="Webhook notification URL (exactly as registered with the processor)" name="notification_url" placeholder="https://waynes-pizza.example.com/api/webhooks/square" />
        </div>
        <div className="grid gap-3">
          <Switch defaultChecked={paymentConsole?.settings.online_card_enabled ?? false} label="Take card payments on the website" name="online_card_enabled" />
          <Switch defaultChecked={paymentConsole?.settings.terminal_card_enabled ?? false} label="Take card payments on a counter card reader" name="terminal_card_enabled" />
        </div>
        <p className="text-sm text-wayne-muted">Switching either on with the environment set to Sandbox charges nothing real — it is the safe way to test the whole flow end to end.</p>
        <div><Button type="submit">Save processor settings</Button></div>
      </form>
    </Card>

    <Card className="mt-6 p-6">
      <h2 className="text-2xl font-black">Card readers</h2>
      <p className="mt-2 text-sm text-wayne-muted">Register each reader with the device ID the processor gives it. The counter can then charge it from Open orders.</p>
      {paymentConsole?.terminals.length ? <ul className="mt-5 grid gap-3">
        {paymentConsole.terminals.map((terminal) => <li className="rounded-xl border border-wayne-border p-4" key={terminal.id}>
          <form action={savePaymentTerminal} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <input name="id" type="hidden" value={terminal.id} />
            <Input defaultValue={terminal.label} id={`label-${terminal.id}`} label="Name" name="label" required />
            <Input defaultValue={terminal.device_id} id={`device-${terminal.id}`} label="Device ID" name="device_id" required />
            <label className="grid gap-2 text-sm font-semibold" htmlFor={`status-${terminal.id}`}>Status
              <select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3" defaultValue={terminal.status} id={`status-${terminal.id}`} name="status">
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </select>
            </label>
            <div className="sm:col-span-3"><Button type="submit" variant="secondary">Save reader</Button>{terminal.last_used_at ? <span className="ml-3 text-sm text-wayne-muted">Last used {formatAdminDateTime(terminal.last_used_at, settings.timezone)}</span> : null}</div>
          </form>
        </li>)}
      </ul> : <p className="mt-4 text-sm text-wayne-muted">No card readers are registered yet.</p>}
      <form action={savePaymentTerminal} className="mt-5 grid gap-3 rounded-xl border border-dashed border-wayne-border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Input id="new-terminal-label" label="New reader name" name="label" placeholder="Front counter" required />
        <Input id="new-terminal-device" label="Device ID" name="device_id" placeholder="9fa747a2-…" required />
        <Button type="submit">Add reader</Button>
      </form>
    </Card>

    <section className="mt-10">
      <h2 className="text-2xl font-black">Reconciliation</h2>
      <p className="mt-1 text-wayne-muted">Everywhere the money and the orders disagree, for the {settings.timezone} business day.</p>
      <Card className="mt-4 p-5"><form className="flex flex-wrap items-end gap-4" method="get">
        <Input defaultValue={from} label="From business date" name="from" type="date" />
        <Input defaultValue={to} label="Through business date" name="to" type="date" />
        <Button type="submit">Run</Button>
        <Button asChild variant="secondary"><Link href="/admin/payments">Today</Link></Button>
      </form></Card>
      {reconciliationError ? <p className="mt-4 rounded-xl border border-wayne-warn/50 bg-wayne-warn-soft p-4 font-bold">{reconciliationError}</p> : null}
      {reconciliation ? <>
        <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Captured" value={formatCents(reconciliation.totals.captured_cents)} />
          <Metric label="Payments taken" value={String(reconciliation.totals.captured_count)} />
          <Metric label="Failed" value={String(reconciliation.totals.failed_count)} />
          <Metric label="Refunded" value={formatCents(reconciliation.totals.refunded_cents)} />
        </dl>
        <h3 className="mt-8 text-xl font-black">Exceptions</h3>
        <Card className="mt-3 overflow-x-auto"><table className="w-full min-w-150 text-left text-sm">
          <thead className="border-b border-wayne-border bg-wayne-cream"><tr>{["Order", "Issue", "Detail", "Amount", "When"].map((header) => <th className="px-4 py-3 font-black" key={header}>{header}</th>)}</tr></thead>
          <tbody>{reconciliation.exceptions.length ? reconciliation.exceptions.map((row, index) => <tr className="border-b border-wayne-border last:border-0" key={`${row.order_number}-${row.issue}-${index}`}>
            <td className="px-4 py-3 font-bold">{row.order_number}</td>
            <td className="px-4 py-3 font-bold">{row.issue}</td>
            <td className="px-4 py-3">{row.detail}</td>
            <td className="px-4 py-3">{formatCents(row.amount_cents)}</td>
            <td className="px-4 py-3">{formatAdminDateTime(row.occurred_at, settings.timezone)}</td>
          </tr>) : <tr><td className="px-4 py-7 text-wayne-muted" colSpan={5}>Nothing disagrees in this range.</td></tr>}</tbody>
        </table></Card>

        <h3 className="mt-8 text-xl font-black">Webhook problems</h3>
        <Card className="mt-3 overflow-x-auto"><table className="w-full min-w-150 text-left text-sm">
          <thead className="border-b border-wayne-border bg-wayne-cream"><tr>{["Event", "Type", "Signature", "Received", "Error"].map((header) => <th className="px-4 py-3 font-black" key={header}>{header}</th>)}</tr></thead>
          <tbody>{reconciliation.webhook_failures.length ? reconciliation.webhook_failures.map((row) => <tr className="border-b border-wayne-border last:border-0" key={row.event_id}>
            <td className="px-4 py-3 font-mono text-xs">{row.event_id}</td>
            <td className="px-4 py-3">{row.event_type}</td>
            <td className={`px-4 py-3 font-bold ${row.signature_verified ? "" : "text-wayne-red"}`}>{row.signature_verified ? "Verified" : "Not verified"}</td>
            <td className="px-4 py-3">{formatAdminDateTime(row.received_at, settings.timezone)}</td>
            <td className="px-4 py-3">{row.processing_error ?? "—"}</td>
          </tr>) : <tr><td className="px-4 py-7 text-wayne-muted" colSpan={5}>Every webhook in this range verified and applied.</td></tr>}</tbody>
        </table></Card>
      </> : null}
    </section>

    {paymentConsole?.recent_webhooks.length ? <section className="mt-10">
      <h2 className="text-2xl font-black">Latest webhooks</h2>
      <Card className="mt-3 overflow-x-auto"><table className="w-full min-w-150 text-left text-sm">
        <thead className="border-b border-wayne-border bg-wayne-cream"><tr>{["Type", "Signature", "Received", "Applied"].map((header) => <th className="px-4 py-3 font-black" key={header}>{header}</th>)}</tr></thead>
        <tbody>{paymentConsole.recent_webhooks.map((row) => <tr className="border-b border-wayne-border last:border-0" key={row.event_id}>
          <td className="px-4 py-3">{row.event_type || "—"}</td>
          <td className={`px-4 py-3 ${row.signature_verified ? "" : "font-bold text-wayne-red"}`}>{row.signature_verified ? "Verified" : "Not verified"}</td>
          <td className="px-4 py-3">{formatAdminDateTime(row.received_at, settings.timezone)}</td>
          <td className="px-4 py-3">{row.processed_at ? formatAdminDateTime(row.processed_at, settings.timezone) : row.processing_error ?? "Not applied"}</td>
        </tr>)}</tbody>
      </table></Card>
    </section> : null}
  </main>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-sm font-bold text-wayne-muted">{label}</dt><dd className="mt-1 text-2xl font-black">{value}</dd></div>;
}

function Switch({ defaultChecked, label, name }: { defaultChecked: boolean; label: string; name: string }) {
  return (
    <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
      <input className="h-5 w-5 accent-wayne-red" defaultChecked={defaultChecked} name={name} type="checkbox" />
      {label}
    </label>
  );
}
