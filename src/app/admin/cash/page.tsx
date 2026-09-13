import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/access";
import { cashMovementLabels, varianceLabel, type CashCloseout } from "@/lib/cash/schemas";
import { getCashCloseout, getRegisters } from "@/lib/cash/queries";
import { getStoreSettings } from "@/lib/content/queries";
import { formatCents } from "@/lib/menu/schemas";
import { formatAdminDateTime } from "@/lib/orders/admin-format";
import { closeDrawerAsManager, saveRegister } from "./actions";

export const metadata: Metadata = { title: "Cash" };
export const dynamic = "force-dynamic";
const dateSchema = z.iso.date();
const single = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

function businessDate(timeZone: string, date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

type Search = { from?: string | string[]; to?: string | string[]; error?: string | string[]; saved?: string | string[] };

export default async function CashPage({ searchParams }: { searchParams: Promise<Search> }) {
  await requirePermission("cash.manage", "/admin/cash");
  const [settings, params, registers] = await Promise.all([getStoreSettings(), searchParams, getRegisters()]);
  const today = businessDate(settings.timezone);
  const rawFrom = single(params.from);
  const rawTo = single(params.to);
  const from = dateSchema.safeParse(rawFrom).success ? rawFrom! : today;
  const to = dateSchema.safeParse(rawTo).success && rawTo! >= from ? rawTo! : from;

  let closeout: CashCloseout | null = null;
  let closeoutError = "";
  try { closeout = await getCashCloseout(from, to); } catch { closeoutError = "The closeout could not be loaded for this range."; }

  const error = single(params.error);
  const saved = single(params.saved);

  return <main className="mx-auto max-w-6xl px-5 py-10">
    <div className="flex flex-wrap items-end justify-between gap-5">
      <div>
        <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Cash</p>
        <h1 className="mt-3 text-4xl font-black">Drawers &amp; day close</h1>
        <p className="mt-3 max-w-3xl text-wayne-muted">What each drawer should hold is worked out from the ledger — cash taken, cash refunded, paid in and out. The only number anyone types is the count.</p>
      </div>
      <Button asChild variant="secondary"><Link href="/admin/reports">Reports</Link></Button>
    </div>

    {error ? <div className="mt-6 rounded-xl border border-wayne-alert/50 bg-wayne-alert-soft p-4 font-bold text-wayne-alert" role="alert">{error}</div> : null}
    {saved ? <div className="mt-6 rounded-xl border border-wayne-ok/50 bg-wayne-ok-soft p-4 font-bold text-wayne-ok" role="status">{saved}</div> : null}

    <Card className="mt-8 p-6">
      <h2 className="text-2xl font-black">Registers</h2>
      <p className="mt-2 text-sm text-wayne-muted">Each till has its own identity so two drawers never share a count.</p>
      {registers.length ? <ul className="mt-5 grid gap-3">
        {registers.map((register) => <li className="rounded-xl border border-wayne-border p-4" key={register.id}>
          <form action={saveRegister} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <input name="id" type="hidden" value={register.id} />
            <Input defaultValue={register.label} id={`label-${register.id}`} label="Name" name="label" required />
            <Input defaultValue={register.location_note} id={`note-${register.id}`} label="Where it is" name="location_note" />
            <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
              <input className="h-5 w-5 accent-wayne-red" defaultChecked={register.active} name="active" type="checkbox" /> In use
            </label>
            <div className="sm:col-span-3"><Button type="submit" variant="secondary">Save register</Button></div>
          </form>
        </li>)}
      </ul> : <p className="mt-4 text-sm text-wayne-muted">No registers yet. Add the first one below — the counter cannot open a drawer until one exists.</p>}
      <form action={saveRegister} className="mt-5 grid gap-3 rounded-xl border border-dashed border-wayne-border p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Input id="new-register-label" label="New register name" name="label" placeholder="Front counter" required />
        <Input id="new-register-note" label="Where it is" name="location_note" placeholder="By the door" />
        <Button type="submit">Add register</Button>
      </form>
    </Card>

    <section className="mt-10">
      <h2 className="text-2xl font-black">Closeout</h2>
      <p className="mt-1 text-wayne-muted">Drawers opened on the {settings.timezone} business day.</p>
      <Card className="mt-4 p-5"><form className="flex flex-wrap items-end gap-4" method="get">
        <Input defaultValue={from} label="From business date" name="from" type="date" />
        <Input defaultValue={to} label="Through business date" name="to" type="date" />
        <Button type="submit">Run</Button>
        <Button asChild variant="secondary"><Link href="/admin/cash">Today</Link></Button>
      </form></Card>
      {closeoutError ? <p className="mt-4 rounded-xl border border-wayne-warn/50 bg-wayne-warn-soft p-4 font-bold">{closeoutError}</p> : null}

      {closeout ? <>
        <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Cash sales" value={formatCents(closeout.totals.cash_sales_cents)} />
          <Metric label="Counted" value={formatCents(closeout.totals.counted_cash_cents)} />
          <Metric label="Expected" value={formatCents(closeout.totals.expected_cash_cents)} />
          <Metric label="Variance" value={`${closeout.totals.variance_cents === 0 ? "" : closeout.totals.variance_cents > 0 ? "+" : "−"}${formatCents(Math.abs(closeout.totals.variance_cents))}`} />
        </dl>
        <Card className="mt-5 p-5"><dl className="grid gap-3 sm:grid-cols-4">
          <Metric label="Drawers" value={`${closeout.totals.shift_count}${closeout.totals.open_count ? ` · ${closeout.totals.open_count} still open` : ""}`} />
          <Metric label="Paid in" value={formatCents(closeout.totals.paid_in_cents)} />
          <Metric label="Paid out and drops" value={formatCents(closeout.totals.paid_out_cents)} />
          <Metric label="Driver cash in" value={formatCents(closeout.totals.driver_cash_cents)} />
        </dl></Card>

        <h3 className="mt-8 text-xl font-black">Drawers</h3>
        <div className="mt-3 grid gap-4">
          {closeout.shifts.length ? closeout.shifts.map((shift) => <Card className="p-5" key={shift.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h4 className="text-xl font-black">{shift.register_label}</h4>
                  <Badge className={shift.status === "open" ? "bg-wayne-warn-soft text-wayne-warn" : "bg-wayne-cream-deep text-wayne-muted"}>{shift.status === "open" ? "Open" : "Closed"}</Badge>
                  {shift.status === "closed" && shift.variance_cents !== null && shift.variance_cents !== 0
                    ? <Badge className="bg-wayne-alert-soft text-wayne-alert">{varianceLabel(shift.variance_cents)} {formatCents(Math.abs(shift.variance_cents))}</Badge>
                    : null}
                </div>
                <p className="mt-2 text-sm text-wayne-muted">
                  {shift.opened_by_name} opened {formatAdminDateTime(shift.opened_at, settings.timezone)}
                  {shift.closed_at ? ` · ${shift.closed_by_name ?? "Unknown"} closed ${formatAdminDateTime(shift.closed_at, settings.timezone)}` : ""}
                </p>
                {shift.close_note ? <p className="mt-2 text-sm"><strong>Note:</strong> {shift.close_note}</p> : null}
              </div>
              <dl className="grid gap-1 text-right text-sm">
                <Line label="Float" value={shift.opening_cash_cents} />
                <Line label="Cash sales" value={shift.cash_sales_cents ?? 0} />
                <Line label="Expected" value={shift.expected_cash_cents ?? 0} />
                {shift.counted_cash_cents !== null ? <Line label="Counted" value={shift.counted_cash_cents} /> : null}
              </dl>
            </div>
            {shift.status === "open" ? <form action={closeDrawerAsManager} className="mt-4 grid gap-3 border-t border-wayne-border pt-4 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
              <input name="shift_id" type="hidden" value={shift.id} />
              <Input id={`counted-${shift.id}`} inputMode="decimal" label="Counted cash" name="counted" placeholder="0.00" required />
              <Input id={`note-close-${shift.id}`} label="Note (required if it is out by $5 or more)" maxLength={1000} name="close_note" />
              <Button type="submit" variant="secondary">Close this drawer</Button>
            </form> : null}
          </Card>) : <Card className="p-10 text-center"><p className="text-wayne-muted">No drawer was opened in this range.</p></Card>}
        </div>

        <h3 className="mt-8 text-xl font-black">Cash movements</h3>
        <Card className="mt-3 overflow-x-auto"><table className="w-full min-w-150 text-left text-sm">
          <thead className="border-b border-wayne-border bg-wayne-cream"><tr>{["Register", "What", "Amount", "Reason", "Who", "When"].map((header) => <th className="px-4 py-3 font-black" key={header}>{header}</th>)}</tr></thead>
          <tbody>{closeout.movements.length ? closeout.movements.map((movement, index) => <tr className="border-b border-wayne-border last:border-0" key={`${movement.created_at}-${index}`}>
            <td className="px-4 py-3">{movement.register_label}</td>
            <td className="px-4 py-3 font-bold">{cashMovementLabels[movement.kind]}</td>
            <td className="px-4 py-3">{formatCents(movement.amount_cents)}</td>
            <td className="px-4 py-3">{movement.reason}</td>
            <td className="px-4 py-3">{movement.actor_name}</td>
            <td className="px-4 py-3">{formatAdminDateTime(movement.created_at, settings.timezone)}</td>
          </tr>) : <tr><td className="px-4 py-7 text-wayne-muted" colSpan={6}>No cash moved in or out of a drawer in this range.</td></tr>}</tbody>
        </table></Card>
      </> : null}
    </section>
  </main>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-sm font-bold text-wayne-muted">{label}</dt><dd className="mt-1 text-2xl font-black">{value}</dd></div>;
}
function Line({ label, value }: { label: string; value: number }) {
  return <div className="flex justify-between gap-4"><dt className="text-wayne-muted">{label}</dt><dd className="font-bold">{formatCents(value)}</dd></div>;
}
