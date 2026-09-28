import type { Metadata } from "next";
import { Flash, first, when } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { getPlatformWorkspace, getPlatformWorkspaceAudit, requirePlatformUser } from "@/lib/platform/queries";

export const metadata: Metadata = { title: "Audit" };
export const dynamic = "force-dynamic";

const actorLabels = { workspace_user: "Staff", platform_user: "Hanafy", system: "System" } as const;
const actorTones = { workspace_user: "neutral", platform_user: "warn", system: "neutral" } as const;

/**
 * Audit tab (§29): Hanafy's own actions on this business, then the business's
 * log (summaries only; field-level changes stay in the business's back office
 * because they can contain customer details).
 */
export default async function PlatformWorkspaceAuditPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const [me, workspace] = await Promise.all([requirePlatformUser(), getPlatformWorkspace(workspaceSlug)]);
  if (me.platform_role === "platform_billing") {
    return <Card className="mt-6 p-6 text-wayne-muted">The billing role does not include business audit logs.</Card>;
  }
  const audit = await getPlatformWorkspaceAudit(workspaceSlug);
  const tz = workspace.timezone;

  return (
    <div className="mt-6">
      <Flash error={first(query.error)} saved={first(query.saved)} />
      <div className="mt-2 grid gap-8 lg:grid-cols-2">
        <section>
          <h2 className="text-2xl font-black">Hanafy actions on {workspace.name}</h2>
          <div className="mt-3 grid gap-2">
            {audit.platform.map((entry) => (
              <Card className="p-4" key={entry.id}>
                <strong className="block">{entry.summary}</strong>
                <span className="text-sm text-wayne-muted">{entry.actor_name} · {when(entry.occurred_at, tz)} · <code>{entry.action}</code></span>
                {entry.reason ? <p className="mt-1 text-sm">Reason: {entry.reason}</p> : null}
              </Card>
            ))}
            {audit.platform.length === 0 ? <Card className="p-5 text-wayne-muted">Hanafy has not changed anything here.</Card> : null}
          </div>
        </section>
        <section>
          <h2 className="text-2xl font-black">Business audit log</h2>
          <div className="mt-3 grid gap-2">
            {audit.workspace.map((entry) => (
              <Card className="p-4" key={entry.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={actorTones[entry.actor_type]}>{actorLabels[entry.actor_type]}</Badge>
                  {entry.support_session_id ? <Badge tone="warn">support session</Badge> : null}
                  <strong>{entry.summary || entry.action}</strong>
                </div>
                <span className="text-sm text-wayne-muted">{entry.actor_name} · {when(entry.occurred_at, tz)} · <code>{entry.action}</code></span>
                {entry.reason ? <p className="mt-1 text-sm">Reason: {entry.reason}</p> : null}
              </Card>
            ))}
            {audit.workspace.length === 0 ? <Card className="p-5 text-wayne-muted">No entries yet.</Card> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
