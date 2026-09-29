import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { first, HealthBadge, serviceName, when, WorkspaceStatus } from "@/components/platform/format";
import { Button } from "@/components/ui/button";
import { getPlatformWorkspaces } from "@/lib/platform/queries";
import { formatMoney } from "@/lib/platform/money";

export const metadata: Metadata = { title: "Businesses" };
export const dynamic = "force-dynamic";

const filtersSchema = z.object({
  status: z.enum(["", "active", "provisioning", "suspended", "archived"]).catch(""),
  q: z.string().trim().max(80).catch(""),
});

/** Businesses on the platform (§11.2). */
export default async function PlatformWorkspacesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [workspaces, params] = await Promise.all([getPlatformWorkspaces(), searchParams]);
  const filters = filtersSchema.parse({ status: first(params.status), q: first(params.q) });
  const needle = filters.q.toLowerCase();
  const rows = workspaces.filter((workspace) =>
    (!filters.status || workspace.status === filters.status)
    && (!needle || [workspace.name, workspace.slug, workspace.owner?.email ?? "", workspace.primary_location?.city ?? ""].some((value) => value.toLowerCase().includes(needle))));

  return (
    <main className="mx-auto max-w-7xl px-5 py-10">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">Hanafy Platform</p>
      <h1 className="mt-3 text-4xl font-black">Businesses</h1>
      <p className="mt-3 max-w-3xl text-wayne-muted">Every business on the platform. New businesses start in provisioning and go live from their setup checklist.</p>
      <div className="mt-4"><Button asChild variant="brand"><Link href="/platform/workspaces/new">Add business</Link></Button></div>

      <form className="mt-6 flex flex-wrap items-end gap-3" method="get">
        <label className="grid gap-2 text-sm font-bold">Status
          <select className="min-h-11 rounded-lg border border-wayne-border bg-white px-3 font-normal" defaultValue={filters.status} name="status">
            <option value="">Any</option><option value="active">Active</option><option value="provisioning">Provisioning</option><option value="suspended">Suspended</option><option value="archived">Archived</option>
          </select>
        </label>
        <label className="grid gap-2 text-sm font-bold">Search
          <input className="min-h-11 rounded-lg border border-wayne-border px-3 font-normal" defaultValue={filters.q} maxLength={80} name="q" placeholder="Name, owner email, city" />
        </label>
        <Button variant="secondary">Filter</Button>
      </form>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-wayne-border bg-wayne-surface">
        <table className="w-full min-w-260 text-left text-sm">
          <thead className="border-b border-wayne-border text-xs uppercase tracking-wider text-wayne-muted">
            <tr>
              <th className="px-4 py-3">Business</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Primary location</th>
              <th className="px-4 py-3">Services on</th><th className="px-4 py-3">Owner</th><th className="px-4 py-3">Messaging</th>
              <th className="px-4 py-3">Payments</th><th className="px-4 py-3">Hardware</th><th className="px-4 py-3">Hanafy billing</th>
              <th className="px-4 py-3">Health</th><th className="px-4 py-3">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((workspace) => (
              <tr className="border-b border-wayne-border/60 align-top last:border-0" key={workspace.id}>
                <td className="px-4 py-3"><Link className="font-bold underline-offset-2 hover:underline" href={`/platform/workspaces/${workspace.slug}`}>{workspace.name}</Link><span className="block text-xs text-wayne-muted">{workspace.slug}</span></td>
                <td className="px-4 py-3"><WorkspaceStatus status={workspace.status} /></td>
                <td className="px-4 py-3">{workspace.primary_location ? <>{workspace.primary_location.name}<span className="block text-xs text-wayne-muted">{[workspace.primary_location.city, workspace.primary_location.state_region].filter(Boolean).join(", ")}{workspace.location_count > 1 ? ` · +${workspace.location_count - 1} more` : ""}</span></> : "—"}</td>
                <td className="max-w-60 px-4 py-3">{workspace.services.length ? workspace.services.map(serviceName).join(", ") : "None"}</td>
                <td className="px-4 py-3">{workspace.owner ? <>{workspace.owner.name}<span className="block text-xs text-wayne-muted">{workspace.owner.email}</span></> : "No owner"}</td>
                <td className="px-4 py-3">{workspace.messaging ? <>{workspace.messaging.sender_address}<span className="block text-xs text-wayne-muted">{workspace.messaging.provider}{workspace.messaging.active ? "" : " · off"}</span></> : "Not set up"}</td>
                <td className="px-4 py-3">{workspace.payment ? <>{workspace.payment.provider}<span className="block text-xs text-wayne-muted">{[workspace.payment.environment, workspace.payment.online_card_enabled ? "online cards" : null, workspace.payment.terminal_card_enabled ? "terminal" : null].filter(Boolean).join(" · ") || "cards off"}</span></> : "Not set up"}</td>
                <td className="px-4 py-3">{workspace.hardware.devices} device{workspace.hardware.devices === 1 ? "" : "s"}<span className={`block text-xs ${workspace.hardware.problems ? "font-bold text-wayne-alert" : "text-wayne-muted"}`}>{workspace.hardware.problems ? `${workspace.hardware.problems} with a problem` : `${workspace.hardware.caller_lines} caller-ID line${workspace.hardware.caller_lines === 1 ? "" : "s"}`}</span></td>
                <td className="px-4 py-3">{workspace.billing?.agreement ? <>{formatMoney(workspace.billing.monthly_recurring_cents)}/mo<span className="block text-xs text-wayne-muted">{workspace.billing.open_balance_cents ? `${formatMoney(workspace.billing.open_balance_cents)} unpaid` : "nothing unpaid"}{workspace.billing.overdue_balance_cents ? " · overdue" : ""}</span></> : <span className="text-wayne-muted">No agreement</span>}</td>
                <td className="px-4 py-3"><HealthBadge level={workspace.health.level} /></td>
                <td className="px-4 py-3">{when(workspace.created_at)}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td className="px-4 py-8 text-center text-wayne-muted" colSpan={11}>No businesses match.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </main>
  );
}
