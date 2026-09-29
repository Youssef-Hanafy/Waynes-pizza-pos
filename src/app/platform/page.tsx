import type { Metadata } from "next";
import Link from "next/link";
import { endSupportSession } from "./actions";
import { Flash, first, HealthBadge, serviceName, when, WorkspaceStatus } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getPlatformDashboard, requirePlatformUser } from "@/lib/platform/queries";
import { formatMoney } from "@/lib/platform/money";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <Card className="p-5">
      <p className="text-sm text-wayne-muted">{label}</p>
      <strong className="mt-1 block text-4xl">{value.toLocaleString("en-US")}</strong>
      {note ? <p className="mt-1 text-xs text-wayne-muted">{note}</p> : null}
    </Card>
  );
}

/**
 * Platform dashboard (§11.1).  Counts and health only: no customer rows or
 * message content from any business appear here.
 */
export default async function PlatformDashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [me, dashboard, params] = await Promise.all([requirePlatformUser(), getPlatformDashboard(), searchParams]);

  return (
    <main className="mx-auto max-w-7xl px-5 py-10">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">Hanafy Platform</p>
      <h1 className="mt-3 text-4xl font-black">Dashboard</h1>
      <Flash error={first(params.error)} saved={first(params.saved)} />

      <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Active businesses" note={`${dashboard.workspaces.total} in total`} value={dashboard.workspaces.active} />
        <Stat label="Provisioning" value={dashboard.workspaces.provisioning} />
        <Stat label="Suspended" value={dashboard.workspaces.suspended} />
        <Stat label="Orders, last 24 hours" note="All businesses" value={dashboard.totals.orders_24h} />
        <Stat label="Customers" note="All businesses combined, aggregate only" value={dashboard.totals.customers} />
        <Stat label="Business staff accounts" value={dashboard.totals.members} />
        <Stat label="Hanafy platform staff" value={dashboard.totals.platform_users} />
        <Card className="p-5">
          <p className="text-sm text-wayne-muted">Hanafy billing</p>
          {dashboard.billing ? (
            <>
              <strong className="mt-1 block text-2xl">{formatMoney(dashboard.billing.monthly_recurring_cents)}<span className="text-sm font-normal text-wayne-muted"> / month</span></strong>
              <p className="mt-1 text-sm">Unpaid {formatMoney(dashboard.billing.open_balance_cents)}{dashboard.billing.overdue_balance_cents ? <strong className="text-wayne-alert"> · {formatMoney(dashboard.billing.overdue_balance_cents)} overdue</strong> : null}</p>
              <p className="text-sm">Equipment owed {formatMoney(dashboard.billing.equipment_balance_cents)}</p>
              {dashboard.billing.without_agreement ? <p className="text-xs text-wayne-warn">{dashboard.billing.without_agreement} business{dashboard.billing.without_agreement === 1 ? "" : "es"} with no agreement recorded</p> : null}
              <Link className="mt-1 inline-block text-xs font-bold underline" href="/platform/billing">Open billing</Link>
            </>
          ) : <strong className="mt-1 block text-lg">Not available</strong>}
        </Card>
      </div>

      <section className="mt-10">
        <h2 className="text-2xl font-black">Needs attention</h2>
        <div className="mt-4 grid gap-3">
          {dashboard.issues.map((issue) => (
            <Card className="flex flex-wrap items-center justify-between gap-3 p-4" key={`${issue.workspace_slug}-${issue.code}`}>
              <span className="flex items-center gap-3">
                <Badge tone={issue.severity}>{issue.severity === "alert" ? "Problem" : "Check"}</Badge>
                <span><strong>{issue.workspace_name}</strong> · {issue.message}</span>
              </span>
              <Link className="text-sm font-bold underline" href={`/platform/workspaces/${issue.workspace_slug}/health`}>Open health</Link>
            </Card>
          ))}
          {dashboard.issues.length === 0 ? <Card className="p-6 text-wayne-muted">No messaging, CRM delivery, printing or payment problems right now.</Card> : null}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-2xl font-black">Businesses</h2>
        <div className="mt-4 overflow-x-auto rounded-2xl border border-wayne-border bg-wayne-surface">
          <table className="w-full min-w-180 text-left text-sm">
            <thead className="border-b border-wayne-border text-xs uppercase tracking-wider text-wayne-muted">
              <tr><th className="px-4 py-3">Business</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Services on</th><th className="px-4 py-3">SMS number</th><th className="px-4 py-3">Last order</th><th className="px-4 py-3">Health</th></tr>
            </thead>
            <tbody>
              {dashboard.workspace_rows.map((workspace) => (
                <tr className="border-b border-wayne-border/60 last:border-0" key={workspace.id}>
                  <td className="px-4 py-3"><Link className="font-bold underline-offset-2 hover:underline" href={`/platform/workspaces/${workspace.slug}`}>{workspace.name}</Link></td>
                  <td className="px-4 py-3"><WorkspaceStatus status={workspace.status} /></td>
                  <td className="px-4 py-3" title={workspace.services.map(serviceName).join(", ")}>{workspace.services.length}</td>
                  <td className="px-4 py-3">{workspace.messaging ? `${workspace.messaging.sender_address}${workspace.messaging.active ? "" : " (off)"}` : "—"}</td>
                  <td className="px-4 py-3">{when(workspace.health.orders.last_order_at)}</td>
                  <td className="px-4 py-3"><HealthBadge level={workspace.health.level} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="text-2xl font-black">Live support sessions</h2>
          <div className="mt-4 grid gap-3">
            {dashboard.support_sessions.map((session) => (
              <Card className="p-4" key={session.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <strong>{session.actor_name}</strong> in <Link className="font-bold underline" href={`/platform/workspaces/${session.workspace_slug}`}>{session.workspace_name}</Link>
                    <p className="text-sm text-wayne-muted">Until {when(session.expires_at)} · {session.reason}</p>
                  </div>
                  {me.can_manage || session.id === me.support_session?.id ? (
                    <form action={endSupportSession}>
                      {session.id === me.support_session?.id ? null : <input name="session_id" type="hidden" value={session.id} />}
                      <input name="return_to" type="hidden" value="/platform" />
                      <Button size="sm" variant="secondary">{session.id === me.support_session?.id ? "End mine" : "Revoke"}</Button>
                    </form>
                  ) : null}
                </div>
              </Card>
            ))}
            {dashboard.support_sessions.length === 0 ? <Card className="p-6 text-wayne-muted">Nobody from Hanafy is inside a business right now.</Card> : null}
          </div>
        </section>
        <section>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-2xl font-black">Recent platform activity</h2>
            <Link className="text-sm font-bold underline" href="/platform/audit">Full log</Link>
          </div>
          <div className="mt-4 grid gap-2">
            {dashboard.recent_audit.map((entry) => (
              <Card className="p-4" key={entry.id}>
                <strong className="block">{entry.summary}</strong>
                <span className="text-sm text-wayne-muted">{entry.actor_name} · {when(entry.occurred_at)}{entry.workspace_name ? ` · ${entry.workspace_name}` : ""}</span>
              </Card>
            ))}
            {dashboard.recent_audit.length === 0 ? <Card className="p-6 text-wayne-muted">No platform actions yet.</Card> : null}
          </div>
        </section>
      </div>
    </main>
  );
}
