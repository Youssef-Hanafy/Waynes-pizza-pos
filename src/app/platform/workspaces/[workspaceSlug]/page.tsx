import type { Metadata } from "next";
import { Flash, first, serviceName, when } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { getPlatformWorkspace } from "@/lib/platform/queries";

export const metadata: Metadata = { title: "Business overview" };
export const dynamic = "force-dynamic";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-black uppercase tracking-wider text-wayne-muted">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  );
}

/** Overview tab (§11.3): configuration metadata and counts, never customer records. */
export default async function PlatformWorkspaceOverviewPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const workspace = await getPlatformWorkspace(workspaceSlug);
  const tz = workspace.timezone;
  const posOn = workspace.services.includes("pos") || workspace.services.includes("online_ordering");

  return (
    <div className="mt-6">
      <Flash error={first(query.error)} saved={first(query.saved)} />
      <div className="mt-2 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h2 className="text-xl font-black">Business</h2>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <Fact label="Primary owner">{workspace.owner ? <>{workspace.owner.name} <span className="text-wayne-muted">· {workspace.owner.email}</span></> : <Badge tone="alert">No active owner</Badge>}</Fact>
            <Fact label="Active staff accounts">{workspace.member_count}</Fact>
            <Fact label="Customers">{workspace.counts.customers.toLocaleString("en-US")}</Fact>
            <Fact label="Orders">{posOn ? <>{workspace.counts.orders_total.toLocaleString("en-US")} <span className="text-wayne-muted">· {workspace.counts.orders_30d.toLocaleString("en-US")} in 30 days</span></> : "POS and online ordering are off"}</Fact>
            <Fact label="Currency">{workspace.currency_code}</Fact>
            <Fact label="Web addresses">{workspace.domains.length ? workspace.domains.map((domain) => <span className="block" key={domain.hostname}>{domain.hostname}{domain.is_canonical ? " (main)" : ""}{domain.active ? "" : " · off"}</span>) : "None"}</Fact>
          </dl>
        </Card>
        <Card className="p-5">
          <h2 className="text-xl font-black">Hanafy billing</h2>
          <p className="mt-3 text-sm text-wayne-muted">Plan, balance and equipment balance are added in Phase 11. Nothing is billed from here yet.</p>
        </Card>
      </div>

      <h2 className="mt-8 text-2xl font-black">Services on</h2>
      <div className="mt-3 flex flex-wrap gap-2">
        {workspace.services.map((code) => <Badge key={code} tone="ok">{serviceName(code)}</Badge>)}
        {workspace.services.length === 0 ? <p className="text-wayne-muted">No services are on.</p> : null}
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <h2 className="text-xl font-black">Messaging</h2>
          {workspace.messaging_identities.length ? workspace.messaging_identities.map((identity) => (
            <div className="mt-3" key={`${identity.channel}-${identity.sender_address}`}>
              <strong className="block">{identity.sender_address}</strong>
              <span className="text-sm text-wayne-muted">{identity.channel.toUpperCase()} · {identity.provider}{identity.active ? "" : " · off"}</span>
            </div>
          )) : <p className="mt-3 text-sm text-wayne-muted">No sending number or address is set.</p>}
          <p className="mt-3 text-xs text-wayne-muted">Usage, opt-outs and registration status move here with the CRM in Phase 7.</p>
        </Card>
        <Card className="p-5">
          <h2 className="text-xl font-black">Payments</h2>
          {workspace.payment_configurations.length ? workspace.payment_configurations.map((config) => (
            <div className="mt-3" key={config.location_id}>
              <strong className="block">{config.provider}</strong>
              <span className="text-sm text-wayne-muted">{[config.environment, config.online_card_enabled ? "online cards on" : "online cards off", config.terminal_card_enabled ? "terminal on" : "terminal off"].filter(Boolean).join(" · ")}</span>
            </div>
          )) : <p className="mt-3 text-sm text-wayne-muted">No card processor is connected.</p>}
          <p className="mt-3 text-sm">Last card payment: {when(workspace.last_card_payment_at, tz)}</p>
          <p className="mt-1 text-xs text-wayne-muted">Connection metadata only. Card data never reaches Hanafy.</p>
        </Card>
        <Card className="p-5">
          <h2 className="text-xl font-black">Hardware</h2>
          <p className="mt-3">{workspace.hardware.devices} device{workspace.hardware.devices === 1 ? "" : "s"} on record · {workspace.hardware.monitored} reporting health</p>
          {workspace.hardware.problems ? <p className="font-bold text-wayne-alert">{workspace.hardware.problems} reporting a problem</p> : null}
          {workspace.hardware.never_seen ? <p className="text-wayne-warn">{workspace.hardware.never_seen} not seen yet</p> : null}
          <p>{workspace.hardware.caller_lines} caller-ID line{workspace.hardware.caller_lines === 1 ? "" : "s"} · {workspace.hardware.registers} active register{workspace.hardware.registers === 1 ? "" : "s"}</p>
          <a className="mt-3 inline-block text-sm font-bold underline" href={`/platform/workspaces/${workspace.slug}/hardware`}>Open hardware</a>
        </Card>
      </div>

      <h2 className="mt-8 text-2xl font-black">Locations</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {workspace.locations.map((location) => (
          <Card className="p-5" key={location.id}>
            <strong className="block text-lg">{location.name}</strong>
            <span className="text-sm text-wayne-muted">{[location.city, location.state_region].filter(Boolean).join(", ")}{location.phone_number ? ` · ${location.phone_number}` : ""} · {location.status}</span>
          </Card>
        ))}
      </div>

      <h2 className="mt-8 text-2xl font-black">Support sessions</h2>
      <p className="mt-1 text-sm text-wayne-muted">The business can see these on its own audit screen.</p>
      <div className="mt-3 grid gap-2">
        {workspace.support_sessions.map((session) => (
          <Card className="p-4" key={session.id}>
            <div className="flex flex-wrap items-center gap-2">
              <strong>{session.actor_name}</strong>
              {session.live ? <Badge tone="warn">Live</Badge> : <Badge tone="neutral">{session.end_reason ?? "expired"}</Badge>}
              <span className="text-sm text-wayne-muted">{when(session.started_at, tz)} → {when(session.ended_at ?? session.expires_at, tz)} · {session.actions} recorded change{session.actions === 1 ? "" : "s"}</span>
            </div>
            <p className="mt-1 text-sm">{session.reason}{session.ticket_reference ? ` · ${session.ticket_reference}` : ""}</p>
          </Card>
        ))}
        {workspace.support_sessions.length === 0 ? <Card className="p-5 text-wayne-muted">Hanafy has never entered this business.</Card> : null}
      </div>
    </div>
  );
}
