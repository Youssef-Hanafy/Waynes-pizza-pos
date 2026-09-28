import type { Metadata } from "next";
import { z } from "zod";
import { setWorkspaceService } from "../../../actions";
import { Flash, first, serviceName, when } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getPlatformWorkspace, requirePlatformUser } from "@/lib/platform/queries";
import type { ServiceEntry } from "@/lib/platform/schemas";
import { utcToZonedLocal } from "@/lib/time/zoned";

export const metadata: Metadata = { title: "Services" };
export const dynamic = "force-dynamic";

const sourceLabels = { plan: "Plan", manual: "Manual", custom_contract: "Custom contract" } as const;
const statusTones = { enabled: "ok", trial: "warn", disabled: "neutral", suspended: "alert" } as const;

const pendingSchema = z.object({
  confirm: z.string().regex(/^[a-z][a-z0-9_]*$/),
  status: z.enum(["enabled", "trial", "disabled", "suspended"]),
  source: z.enum(["plan", "manual", "custom_contract"]),
  starts_on: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/),
  ends_on: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/),
  reason: z.string().max(500),
  warnings: z.string().max(4000).transform((value, context) => {
    try {
      return z.array(z.string().max(400)).max(8).parse(JSON.parse(value));
    } catch {
      context.addIssue({ code: "custom", message: "bad warnings" });
      return z.NEVER;
    }
  }),
});

const dateOnly = (iso: string | null, timeZone: string) => (iso ? utcToZonedLocal(iso, timeZone).slice(0, 10) : "");

/** Services tab (§9, §11.3): what this business has, why, and switching it. */
export default async function PlatformWorkspaceServicesPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const [me, workspace] = await Promise.all([requirePlatformUser(), getPlatformWorkspace(workspaceSlug)]);
  const pending = pendingSchema.safeParse(Object.fromEntries(["confirm", "status", "source", "starts_on", "ends_on", "reason", "warnings"].map((key) => [key, first(query[key]) ?? ""])));
  const confirming = pending.success ? pending.data : null;
  const tz = workspace.timezone;

  return (
    <div className="mt-6">
      {confirming ? null : <Flash error={first(query.error)} saved={first(query.saved)} />}
      {confirming ? (
        <Card className="mt-2 border-wayne-alert/50 p-5">
          <h2 className="text-xl font-black">Confirm: set {serviceName(confirming.confirm)} to {confirming.status} for {workspace.name}?</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5">{confirming.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          <form action={setWorkspaceService} className="mt-4 flex flex-wrap gap-3">
            {Object.entries({ workspace: workspace.slug, service: confirming.confirm, status: confirming.status, source: confirming.source, starts_on: confirming.starts_on, ends_on: confirming.ends_on, reason: confirming.reason, confirmed: "yes" })
              .map(([name, value]) => <input key={name} name={name} type="hidden" value={value} />)}
            <Button variant="danger">Yes, make this change</Button>
            <Button asChild variant="secondary"><a href={`/platform/workspaces/${workspace.slug}/services`}>Cancel</a></Button>
          </form>
        </Card>
      ) : null}

      <p className="mt-4 max-w-3xl text-sm text-wayne-muted">
        A service that is off is enforced by the database: its screens disappear and its actions, API routes and data are refused for everyone in this business.
        Every change needs a reason and is recorded in the platform log and in the business&apos;s own audit log.
        {me.can_manage ? "" : " Your platform role can view services but not change them."}
      </p>

      <div className="mt-5 grid gap-3">
        {workspace.service_catalog.map((service) => <ServiceRow canManage={me.can_manage} key={service.code} service={service} timeZone={tz} workspaceSlug={workspace.slug} />)}
      </div>
    </div>
  );
}

function ServiceRow({ service, workspaceSlug, timeZone, canManage }: { service: ServiceEntry; workspaceSlug: string; timeZone: string; canManage: boolean }) {
  const scheduled = service.status !== "disabled" && !service.effective;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="text-lg">{service.name}</strong>
            <Badge tone={statusTones[service.status]}>{service.status}</Badge>
            {scheduled ? <Badge tone="warn">not active now</Badge> : null}
            {service.source ? <Badge tone="neutral">{sourceLabels[service.source]}</Badge> : null}
            {service.catalog_active ? null : <Badge tone="alert">retired</Badge>}
          </div>
          {service.description ? <p className="mt-1 text-sm text-wayne-muted">{service.description}</p> : null}
          <p className="mt-2 text-sm">
            {service.starts_at || service.ends_at ? <>Window: {service.starts_at ? when(service.starts_at, timeZone) : "now"} → {service.ends_at ? when(service.ends_at, timeZone) : "open-ended"}. </> : null}
            {service.requires_any.length ? <>Needs {service.requires_any.map(serviceName).join(" or ")}. </> : null}
            {service.required_by.length ? <>Needed by {service.required_by.map(serviceName).join(", ")}. </> : null}
            {service.updated_at ? <span className="text-wayne-muted">Last changed {when(service.updated_at, timeZone)}.</span> : <span className="text-wayne-muted">Never turned on.</span>}
          </p>
          {service.permissions.length ? <p className="mt-1 text-xs text-wayne-muted">Controls: {service.permissions.join(" · ")}</p> : null}
        </div>
      </div>
      {canManage ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-bold">Change</summary>
          <form action={setWorkspaceService} className="mt-3 grid gap-3 md:grid-cols-[10rem_12rem_10rem_10rem] md:items-end">
            <input name="workspace" type="hidden" value={workspaceSlug} />
            <input name="service" type="hidden" value={service.code} />
            <label className="grid gap-1.5 text-sm font-bold">Status
              <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue={service.status} name="status">
                <option value="enabled">Enabled</option><option value="trial">Trial</option><option value="disabled">Disabled</option><option value="suspended">Suspended</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-bold">Why it is on
              <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue={service.source ?? "manual"} name="source">
                <option value="manual">Manual</option><option value="plan">Plan</option><option value="custom_contract">Custom contract</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-bold">Starts (optional)
              <input className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue={dateOnly(service.starts_at, timeZone)} name="starts_on" type="date" />
            </label>
            <label className="grid gap-1.5 text-sm font-bold">Ends (optional)
              <input className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue={dateOnly(service.ends_at, timeZone)} name="ends_on" type="date" />
            </label>
            <label className="grid gap-1.5 text-sm font-bold md:col-span-3">Reason (recorded)
              <input className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" maxLength={500} minLength={3} name="reason" placeholder="e.g. Signed the SMS add-on on the 1st" required />
            </label>
            <Button variant="brand">Save</Button>
          </form>
        </details>
      ) : null}
    </Card>
  );
}
