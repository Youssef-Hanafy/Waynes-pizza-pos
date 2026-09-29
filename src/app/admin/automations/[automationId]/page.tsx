import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Flash, first, when } from "@/components/platform/format";
import { requirePermission } from "@/lib/auth/access";
import { getAutomationDetail, getAutomationsOverview } from "@/lib/automations/queries";
import { triggerLabel } from "@/lib/automations/schemas";
import { workspaceTimezone } from "@/lib/messaging/queries";
import { replayEvent, setAutomationStatus } from "../actions";
import { AutomationForm } from "../automation-form";

export const metadata: Metadata = { title: "Automation" };
export const dynamic = "force-dynamic";

const levelTone = { info: "ok", skip: "neutral", error: "alert" } as const;

/** One automation: switch it, see every run and why, edit (new version), replay an event. */
export default async function AutomationPage({ params, searchParams }: { params: Promise<{ automationId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await requirePermission("automations.view", "/admin/automations");
  const slug = access.workspace_slug ?? "";
  const [{ automationId }, query] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/.test(automationId)) notFound();
  const [overview, detail, tz] = await Promise.all([getAutomationsOverview(slug), getAutomationDetail(slug, automationId), workspaceTimezone(slug)]);
  const automation = overview.automations.find((item) => item.id === automationId);
  if (!automation || !detail) notFound();
  const legacy = automation.executor === "legacy_crm";
  const canChange = overview.can_manage && !legacy;

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <Link className="text-sm font-bold text-wayne-muted hover:underline" href="/admin/automations">← Automations</Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-4xl font-black">{automation.name}</h1>
        <Badge tone={automation.status === "active" ? "ok" : automation.status === "paused" ? "warn" : "neutral"}>{automation.status}</Badge>
        {legacy ? <Badge tone="warn">Runs in the Hanafy CRM</Badge> : null}
      </div>
      <p className="mt-2 text-wayne-muted">{automation.trigger_event_type ? triggerLabel(automation.trigger_event_type) : ""}{automation.version ? ` · version ${automation.version}` : ""}</p>
      <Flash error={first(query.error)} saved={first(query.saved)} />

      {canChange ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {(["active", "paused", "archived"] as const).filter((status) => status !== automation.status).map((status) => (
            <form action={setAutomationStatus} key={status}>
              <input name="id" type="hidden" value={automation.id} /><input name="status" type="hidden" value={status} />
              <Button size="sm" variant={status === "active" ? "brand" : status === "archived" ? "danger" : "secondary"}>{status === "active" ? "Switch on" : status === "paused" ? "Pause" : "Archive"}</Button>
            </form>
          ))}
        </div>
      ) : null}

      <section className="mt-8">
        <h2 className="text-2xl font-black">Runs</h2>
        <div className="mt-3 grid gap-2">
          {detail.runs.map((run) => (
            <Card className="p-4" key={run.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{run.customer_name ?? "No customer"} · {run.event_type ? triggerLabel(run.event_type) : "event"}</strong>
                <Badge tone={run.status === "completed" ? "ok" : run.status === "failed" ? "alert" : run.status === "waiting" ? "warn" : "neutral"}>{run.status}</Badge>
              </div>
              <p className="mt-1 text-sm text-wayne-muted">
                {when(run.created_at, tz)}{run.version ? ` · v${run.version}` : ""}{run.status === "waiting" ? ` · runs ${when(run.due_at, tz)}` : ""}{run.replayed ? " · replayed" : ""}
              </p>
              {run.outcome ? <p className="mt-1 text-sm">{run.outcome}</p> : null}
              {run.steps.length ? <ul className="mt-2 list-disc pl-5 text-sm">{run.steps.map((step) => <li key={step.step}>Step {step.step} ({step.action}): {step.status}{step.detail ? ` — ${step.detail}` : ""}</li>)}</ul> : null}
            </Card>
          ))}
          {detail.runs.length === 0 ? <Card className="p-5 text-wayne-muted">{legacy ? "Runs for this automation happen in the Hanafy CRM." : "No runs yet."}</Card> : null}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-2xl font-black">What happened, in plain words</h2>
        <ul className="mt-3 grid gap-1 text-sm">
          {detail.log.map((line, index) => <li className="flex gap-2" key={`${line.at}-${index}`}><Badge tone={levelTone[line.level]}>{line.level}</Badge><span>{when(line.at, tz)} — {line.message}</span></li>)}
          {detail.log.length === 0 ? <li className="text-wayne-muted">Nothing yet.</li> : null}
        </ul>
      </section>

      {canChange ? (
        <>
          <section className="mt-10">
            <h2 className="text-2xl font-black">Edit</h2>
            <p className="mt-1 text-sm text-wayne-muted">Saving creates version {(automation.version ?? 0) + 1}. Runs already waiting keep the version they started with.</p>
            <div className="mt-4"><AutomationForm automation={automation} eventTypes={overview.event_types} segments={overview.segments} /></div>
          </section>
          <Card className="mt-8 p-5">
            <h2 className="text-xl font-black">Replay an event</h2>
            <p className="mt-1 text-sm text-wayne-muted">Checks one recorded event against this automation again. An event that already produced a run never produces a second one. Recorded in the audit log.</p>
            <form action={replayEvent} className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
              <input name="id" type="hidden" value={automation.id} />
              <Input label="Event id" name="event_id" placeholder="from Recent events" required />
              <Input label="Why?" minLength={5} name="reason" placeholder="Automation was created after this event" required />
              <Button variant="secondary">Replay</Button>
            </form>
          </Card>
        </>
      ) : null}

      {detail.versions?.length ? (
        <section className="mt-8">
          <h2 className="text-xl font-black">Versions</h2>
          <ul className="mt-2 grid gap-1 text-sm">
            {detail.versions.map((version) => (
              <li key={version.id}>v{version.version} · {when(version.created_at, tz)} · {triggerLabel(version.trigger_event_type)} · {version.conditions.length} conditions · waits {version.delay_minutes} min · {version.actions.map((action) => action.type).join(", ")}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
