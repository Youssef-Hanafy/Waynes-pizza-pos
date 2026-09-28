import type { Metadata } from "next";
import { Flash, first, HealthBadge, when } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { getPlatformWorkspace } from "@/lib/platform/queries";

export const metadata: Metadata = { title: "Health" };
export const dynamic = "force-dynamic";

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "ok" | "warn" | "alert" }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-wayne-border/60 py-2 last:border-0">
      <span className="text-sm text-wayne-muted">{label}</span>
      <span className={`text-right font-bold ${tone === "alert" ? "text-wayne-alert" : tone === "warn" ? "text-wayne-warn" : ""}`}>{value}</span>
    </div>
  );
}

/** Health tab (§30): counts and timestamps from the live system, no payloads. */
export default async function PlatformWorkspaceHealthPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const workspace = await getPlatformWorkspace(workspaceSlug);
  const { health } = workspace;
  const tz = workspace.timezone;

  return (
    <div className="mt-6">
      <Flash error={first(query.error)} saved={first(query.saved)} />
      <div className="mt-2 flex items-center gap-3"><h2 className="text-2xl font-black">Right now</h2><HealthBadge level={health.level} /></div>
      <div className="mt-3 grid gap-2">
        {health.issues.map((issue) => (
          <Card className="flex items-center gap-3 p-4" key={issue.code}><Badge tone={issue.severity}>{issue.severity === "alert" ? "Problem" : "Check"}</Badge>{issue.message}</Card>
        ))}
        {health.issues.length === 0 ? <Card className="p-5 text-wayne-muted">Nothing needs attention.</Card> : null}
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Card className="p-5">
          <h3 className="text-lg font-black">Hanafy CRM events</h3>
          <Row label="CRM service" value={health.outbox.crm_enabled ? "On" : "Off (events wait)"} tone={health.outbox.crm_enabled ? undefined : "warn"} />
          <Row label="Waiting to send" value={health.outbox.pending} tone={health.outbox.pending > 0 ? "warn" : undefined} />
          <Row label="Oldest waiting since" value={when(health.outbox.oldest_pending_at, tz)} />
          <Row label="Failed" value={health.outbox.failed} tone={health.outbox.failed > 0 ? "alert" : undefined} />
          <Row label="Last delivered" value={when(health.outbox.last_delivered_at, tz)} />
          {health.outbox.last_error ? <p className="mt-3 break-words rounded-lg bg-wayne-alert-soft p-3 text-xs">{health.outbox.last_error}</p> : null}
        </Card>
        <Card className="p-5">
          <h3 className="text-lg font-black">Orders</h3>
          <Row label="Last order" value={when(health.orders.last_order_at, tz)} />
          <Row label="Orders in the last 24 hours" value={health.orders.last_24h} />
          <h3 className="mt-5 text-lg font-black">Payments</h3>
          <Row label="Webhook problems (7 days)" value={health.payments.webhook_problems_7d} tone={health.payments.webhook_problems_7d > 0 ? "alert" : undefined} />
          <Row label="Last card payment" value={when(workspace.last_card_payment_at, tz)} />
        </Card>
        <Card className="p-5">
          <h3 className="text-lg font-black">Printing</h3>
          <Row label="Failed jobs (24 hours)" value={health.printing.failed_24h} tone={health.printing.failed_24h > 0 ? "warn" : undefined} />
          <Row label="Jobs waiting over 10 minutes" value={health.printing.stuck} tone={health.printing.stuck > 0 ? "warn" : undefined} />
        </Card>
        <Card className="p-5">
          <h3 className="text-lg font-black">Caller ID & devices</h3>
          <Row label="Last real call" value={when(health.caller_id.last_ring_at, tz)} />
          <Row label="Active registers" value={workspace.hardware.registers} />
          <Row label="Caller-ID lines" value={workspace.hardware.caller_lines} />
          <p className="mt-3 text-xs text-wayne-muted">Per-device last-seen and heartbeat health arrive with hardware administration in Phase 10.</p>
        </Card>
      </div>
    </div>
  );
}
