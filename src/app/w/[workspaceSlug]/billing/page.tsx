import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { workspaceHanafyBillingSchema } from "@/lib/platform/billing";
import { formatMoney } from "@/lib/platform/money";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { workspaceSlugSchema } from "@/lib/tenancy/schemas";

export const metadata: Metadata = { title: "Hanafy bill" };
export const dynamic = "force-dynamic";

/**
 * What this business owes Hanafy Media (Phase 11): agreement, issued
 * invoices and equipment balances.  Read-only; owners/managers with
 * settings.manage only.  Not the business's own customer payments.
 */
export default async function WorkspaceHanafyBillPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await params;
  if (!workspaceSlugSchema.safeParse(workspaceSlug).success) notFound();
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_workspace_hanafy_billing", { target_workspace_slug: workspaceSlug });
  if (error) notFound();
  const bill = workspaceHanafyBillingSchema.parse(data);
  const { totals } = bill;

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <h1 className="text-4xl font-black">Hanafy bill</h1>
      <p className="mt-2 text-wayne-muted">Your account with Hanafy Media for software and equipment. Questions: reply to your latest invoice or contact Hanafy Media.</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Card className="p-5"><p className="text-sm text-wayne-muted">Your agreement</p><strong className="mt-1 block text-xl">{totals.agreement?.label ?? "Not recorded yet"}</strong><p className="text-sm">{formatMoney(totals.monthly_recurring_cents)} a month</p></Card>
        <Card className="p-5"><p className="text-sm text-wayne-muted">Unpaid invoices</p><strong className={`mt-1 block text-3xl ${totals.overdue_balance_cents ? "text-wayne-alert" : ""}`}>{formatMoney(totals.open_balance_cents)}</strong>{totals.overdue_balance_cents ? <p className="text-sm font-bold text-wayne-alert">{formatMoney(totals.overdue_balance_cents)} past due</p> : null}</Card>
        <Card className="p-5"><p className="text-sm text-wayne-muted">Owed on equipment</p><strong className="mt-1 block text-3xl">{formatMoney(totals.equipment_balance_cents)}</strong></Card>
      </div>

      <h2 className="mt-8 text-2xl font-black">Invoices</h2>
      <div className="mt-3 grid gap-2">
        {bill.invoices.map((invoice) => (
          <Card className="flex flex-wrap items-center justify-between gap-3 p-4" key={invoice.id}>
            <span><strong>{invoice.invoice_number}</strong> <span className="text-sm text-wayne-muted">· issued {invoice.issue_date} · due {invoice.due_date}</span></span>
            <span className="flex items-center gap-3">
              <span>{formatMoney(invoice.total_cents)}</span>
              {invoice.status === "paid" ? <Badge tone="ok">Paid</Badge> : <Badge tone={invoice.overdue ? "alert" : "warn"}>{formatMoney(invoice.balance_due_cents)} {invoice.overdue ? "past due" : "due"}</Badge>}
            </span>
          </Card>
        ))}
        {bill.invoices.length === 0 ? <Card className="p-5 text-wayne-muted">No invoices yet.</Card> : null}
      </div>

      {bill.equipment.length ? (
        <>
          <h2 className="mt-8 text-2xl font-black">Equipment from Hanafy</h2>
          <div className="mt-3 grid gap-2">
            {bill.equipment.map((asset) => (
              <Card className="flex flex-wrap items-center justify-between gap-3 p-4" key={asset.name}>
                <span><strong>{asset.name}</strong>{asset.payment_schedule ? <span className="text-sm text-wayne-muted"> · {asset.payment_schedule}</span> : null}</span>
                <span>{asset.balance_due_cents > 0 ? `${formatMoney(asset.balance_due_cents)} left of ${formatMoney(asset.charged_cents)}` : "Paid off"}</span>
              </Card>
            ))}
          </div>
        </>
      ) : null}
    </main>
  );
}
