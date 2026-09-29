import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Flash, first, when } from "@/components/platform/format";
import { requirePermission } from "@/lib/auth/access";
import { getAutomationsOverview } from "@/lib/automations/queries";
import { triggerLabel } from "@/lib/automations/schemas";
import { workspaceTimezone } from "@/lib/messaging/queries";
import { AutomationForm } from "./automation-form";

export const metadata: Metadata = { title: "Automations" };
export const dynamic = "force-dynamic";

const tones = { active: "ok", draft: "neutral", paused: "warn", archived: "neutral" } as const;

/** Automation Engine (§17.2): event-driven workflows for this business only. */
export default async function AutomationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await requirePermission("automations.view", "/admin/automations");
  const slug = access.workspace_slug ?? "";
  const [query, overview, tz] = await Promise.all([searchParams, getAutomationsOverview(slug), workspaceTimezone(slug)]);
  const legacy = overview.dispatch_mode !== "platform";

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Marketing</p>
      <h1 className="mt-3 text-4xl font-black">Automations</h1>
      <p className="mt-3 max-w-3xl text-wayne-muted">
        Something happens (a customer goes quiet, joins the text club, places an order) and the automation acts: a text, a tag. Each event can start an automation only once, and every run explains what it did or why it didn&apos;t.
      </p>
      <Flash error={first(query.error)} saved={first(query.saved)} />
      {legacy ? (
        <Card className="mt-5 border-wayne-warn/40 bg-wayne-warn-soft p-5">
          <strong>This business&apos;s texts still go out from the Hanafy CRM.</strong> Automations marked &quot;Runs in the Hanafy CRM&quot; are shown here for reference. New texting automations can be built here and switched on once Hanafy moves texting to the platform.
        </Card>
      ) : null}

      <div className="mt-7 grid gap-3">
        {overview.automations.map((automation) => (
          <Link href={`/admin/automations/${automation.id}`} key={automation.id}>
            <Card className="flex flex-wrap items-center justify-between gap-3 p-4 transition hover:border-wayne-border-strong">
              <div>
                <strong>{automation.name}</strong>
                <p className="text-sm text-wayne-muted">
                  {automation.trigger_event_type ? triggerLabel(automation.trigger_event_type) : "No trigger"}
                  {automation.delay_minutes ? ` · waits ${automation.delay_minutes} min` : ""}
                  {automation.version ? ` · v${automation.version}` : ""}
                  {automation.runs_30d ? ` · 30 days: ${Object.entries(automation.runs_30d).map(([status, count]) => `${count} ${status}`).join(", ")}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {automation.executor === "legacy_crm" ? <Badge tone="warn">Runs in the Hanafy CRM</Badge> : null}
                <Badge tone={tones[automation.status]}>{automation.status}</Badge>
              </div>
            </Card>
          </Link>
        ))}
        {overview.automations.length === 0 ? <Card className="p-6 text-wayne-muted">No automations yet.</Card> : null}
      </div>

      {overview.can_manage ? (
        <details className="mt-6">
          <summary className="cursor-pointer text-lg font-black">New automation</summary>
          <div className="mt-4"><AutomationForm eventTypes={overview.event_types} segments={overview.segments} /></div>
        </details>
      ) : null}

      <section className="mt-10">
        <h2 className="text-2xl font-black">Recent events</h2>
        <p className="mt-1 text-sm text-wayne-muted">What the business recorded. Copy an event id to replay it into an automation.</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr className="text-wayne-muted"><th className="py-2">When</th><th>Event</th><th>Automations</th><th>Id</th></tr></thead>
            <tbody>
              {overview.recent_events.map((event) => (
                <tr className="border-t border-wayne-border/60" key={event.event_id}>
                  <td className="py-2">{when(event.occurred_at, tz)}</td>
                  <td>{triggerLabel(event.event_type)}{event.has_customer ? "" : " (no customer)"}</td>
                  <td>{event.automation_status}</td>
                  <td><code className="select-all text-xs">{event.event_id}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
