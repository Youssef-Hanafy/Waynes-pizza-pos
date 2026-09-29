import type { Metadata } from "next";
import { z } from "zod";
import { adoptLegacyAutomations, saveWorkspaceMessaging } from "../../../actions";
import { Flash, first, when } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getPlatformWorkspace, getPlatformWorkspaceMessaging } from "@/lib/platform/queries";

export const metadata: Metadata = { title: "Messaging" };
export const dynamic = "force-dynamic";

const pendingSchema = z.object({
  confirm: z.literal("messaging"),
  reason: z.string().max(500),
  pending_payload: z.string().max(4000),
  warnings: z.string().max(4000).transform((value, context) => {
    try {
      return z.array(z.string().max(400)).max(8).parse(JSON.parse(value));
    } catch {
      context.addIssue({ code: "custom", message: "bad warnings" });
      return z.NEVER;
    }
  }),
});

function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "warn" | "alert" }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-wayne-border/60 py-2 last:border-0">
      <span className="text-sm text-wayne-muted">{label}</span>
      <span className={`text-right font-bold ${tone === "alert" ? "text-wayne-alert" : tone === "warn" ? "text-wayne-warn" : ""}`}>{value}</span>
    </div>
  );
}

const select = "min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal";

/** Messaging tab (§11.3, §19): provider, numbers, sending mode, usage, failures and opt-outs. */
export default async function PlatformWorkspaceMessagingPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const [workspace, messaging] = await Promise.all([getPlatformWorkspace(workspaceSlug), getPlatformWorkspaceMessaging(workspaceSlug)]);
  const pending = pendingSchema.safeParse(Object.fromEntries(["confirm", "reason", "pending_payload", "warnings"].map((key) => [key, first(query[key]) ?? ""])));
  const confirming = pending.success ? pending.data : null;
  const tz = workspace.timezone;
  const connection = messaging.connection;

  return (
    <div className="mt-6">
      {confirming ? (
        <Card className="mt-2 border-wayne-alert/50 p-5">
          <h2 className="text-xl font-black">Confirm the messaging change for {workspace.name}</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5">{confirming.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          <form action={saveWorkspaceMessaging} className="mt-4 flex flex-wrap gap-3">
            <input name="workspace" type="hidden" value={workspace.slug} />
            <input name="reason" type="hidden" value={confirming.reason} />
            <input name="pending_payload" type="hidden" value={confirming.pending_payload} />
            <input name="confirmed" type="hidden" value="yes" />
            <Button variant="danger">Yes, make this change</Button>
            <Button asChild variant="secondary"><a href={`/platform/workspaces/${workspace.slug}/messaging`}>Cancel</a></Button>
          </form>
        </Card>
      ) : (
        <Flash error={first(query.error)} saved={first(query.saved)} />
      )}

      <div className="mt-2 grid gap-4 md:grid-cols-2">
        <Card className="p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-black">Connection</h2>
            {connection ? <Badge tone={connection.status === "active" ? "ok" : connection.status === "sandbox" || connection.status === "provisioning" ? "warn" : "alert"}>{connection.status}</Badge> : <Badge tone="neutral">not set up</Badge>}
          </div>
          {connection ? (
            <div className="mt-3">
              <Row label="Provider" value="AWS End User Messaging" />
              <Row label="Region" value={connection.aws_region ?? "—"} />
              <Row label="Who sends" value={connection.dispatch_mode === "platform" ? "Hanafy Platform" : "Old Hanafy CRM (bridge)"} tone={connection.dispatch_mode === "platform" ? undefined : "warn"} />
              <Row label="Platform sending" value={connection.dispatch_mode !== "platform" ? "Off (CRM sends)" : connection.live_sending ? "Live" : "Simulated"} />
              <Row label="Credentials" value={connection.secret_reference ?? "Not set"} tone={connection.dispatch_mode === "platform" && connection.live_sending && !connection.secret_reference ? "alert" : undefined} />
              <Row label="10DLC / registration" value={connection.registration_status ?? "unknown"} />
              <Row label="Production access" value={connection.production_access_status ?? "unknown"} />
              <Row label="Last success" value={when(connection.last_success_at, tz)} />
              <Row label="Last error" value={when(connection.last_error_at, tz)} tone={connection.last_error_at ? "alert" : undefined} />
              {connection.last_error_summary ? <p className="mt-3 break-words rounded-lg bg-wayne-alert-soft p-3 text-xs">{connection.last_error_summary}</p> : null}
            </div>
          ) : (
            <p className="mt-3 text-sm text-wayne-muted">This business cannot send texts until a connection and a number are added. Nothing falls back to another business&apos;s number.</p>
          )}
        </Card>
        <Card className="p-5">
          <h2 className="text-xl font-black">Usage</h2>
          <div className="mt-3">
            <Row label="Sent (24 hours)" value={messaging.usage.sent_24h} />
            <Row label="Sent (30 days)" value={messaging.usage.sent_30d} />
            <Row label="Simulated (30 days)" value={messaging.usage.simulated_30d} />
            <Row label="Failed (30 days)" value={messaging.usage.failed_30d} tone={messaging.usage.failed_30d ? "alert" : undefined} />
            <Row label="Skipped for consent/opt-out (30 days)" value={messaging.usage.skipped_30d} />
            <Row label="Outcome unknown" value={messaging.usage.unknown} tone={messaging.usage.unknown ? "warn" : undefined} />
            <Row label="Waiting to send" value={messaging.usage.queued} />
            <Row label="Text subscribers" value={messaging.subscribers} />
            <Row label="Opted out" value={messaging.opt_outs} />
            <Row label="Campaigns" value={messaging.campaigns} />
          </div>
          {messaging.legacy_crm ? (
            <p className="mt-3 text-xs text-wayne-muted">Old Hanafy CRM business <code>{messaging.legacy_crm.business_slug}</code> ({messaging.legacy_crm.project_ref}). {messaging.legacy_crm.notes}</p>
          ) : null}
        </Card>
      </div>

      <h2 className="mt-8 text-2xl font-black">Sending numbers</h2>
      <div className="mt-3 grid gap-2">
        {messaging.identities.map((identity) => (
          <Card className="flex flex-wrap items-center justify-between gap-3 p-4" key={identity.id}>
            <div>
              <strong>{identity.phone_number}</strong>{identity.is_default ? <Badge className="ml-2" tone="ok">default</Badge> : null}
              <p className="text-sm text-wayne-muted">{identity.message_type} · {identity.identity_type ?? "type not recorded"} · {identity.provider_identity_arn ?? "no AWS id"}{identity.legacy ? " · from the old CRM" : ""}</p>
            </div>
            <Badge tone={identity.status === "active" ? "ok" : identity.status === "retired" ? "neutral" : "warn"}>{identity.status}</Badge>
          </Card>
        ))}
        {messaging.identities.length === 0 ? <Card className="p-5 text-wayne-muted">No numbers. Texts to this business&apos;s customers will fail with a clear error until one is added.</Card> : null}
      </div>

      {messaging.recent_failures.length ? (
        <>
          <h2 className="mt-8 text-2xl font-black">Recent failures</h2>
          <div className="mt-3 grid gap-2">
            {messaging.recent_failures.map((failure) => (
              <Card className="p-4 text-sm" key={failure.id}><strong>{when(failure.at, tz)}</strong> · …{failure.recipient_last4} · {failure.status}{failure.error ? ` — ${failure.error}` : ""}</Card>
            ))}
          </div>
        </>
      ) : null}

      {messaging.can_manage && !confirming ? (
        <Card className="mt-8 p-5">
          <h2 className="text-xl font-black">Change messaging</h2>
          <p className="mt-1 text-sm text-wayne-muted">Blank fields stay as they are. Credentials are never typed here: set <code>PREFIX_ACCESS_KEY_ID</code> and <code>PREFIX_SECRET_ACCESS_KEY</code> on the server and enter <code>env:PREFIX</code>.</p>
          <form action={saveWorkspaceMessaging} className="mt-4 grid gap-4 md:grid-cols-3">
            <input name="workspace" type="hidden" value={workspace.slug} />
            <label className="grid gap-1.5 text-sm font-bold">Status
              <select className={select} defaultValue="" name="status"><option value="">(unchanged)</option>{["provisioning", "sandbox", "active", "suspended", "error"].map((value) => <option key={value} value={value}>{value}</option>)}</select>
            </label>
            <label className="grid gap-1.5 text-sm font-bold">Who sends
              <select className={select} defaultValue="" name="dispatch_mode"><option value="">(unchanged)</option><option value="legacy_crm_bridge">Old Hanafy CRM (bridge)</option><option value="platform">Hanafy Platform</option></select>
            </label>
            <label className="grid gap-1.5 text-sm font-bold">Platform sending
              <select className={select} defaultValue="" name="live_sending"><option value="">(unchanged)</option><option value="no">Simulated</option><option value="yes">Live (real texts)</option></select>
            </label>
            <Input label="AWS region" name="aws_region" placeholder={connection?.aws_region ?? "us-east-1"} />
            <Input label="Credentials reference" name="secret_reference" placeholder="env:WAYNES_SMS" />
            <Input label="AWS account reference" name="provider_account_ref" placeholder="optional" />
            <label className="grid gap-1.5 text-sm font-bold">10DLC / registration
              <select className={select} defaultValue="" name="registration_status"><option value="">(unchanged)</option>{["not_started", "submitted", "approved", "rejected", "not_required"].map((value) => <option key={value} value={value}>{value}</option>)}</select>
            </label>
            <label className="grid gap-1.5 text-sm font-bold">Production access
              <select className={select} defaultValue="" name="production_access_status"><option value="">(unchanged)</option>{["sandbox", "requested", "granted", "denied"].map((value) => <option key={value} value={value}>{value}</option>)}</select>
            </label>
            <div />
            <fieldset className="grid gap-4 rounded-xl border border-wayne-border p-4 md:col-span-3 md:grid-cols-3">
              <legend className="px-1 text-sm font-black">Sending number (optional)</legend>
              <label className="grid gap-1.5 text-sm font-bold">Number
                <select className={select} defaultValue="" name="identity_id"><option value="">Add a new number</option>{messaging.identities.map((identity) => <option key={identity.id} value={identity.id}>{identity.phone_number}</option>)}</select>
              </label>
              <Input label="New number" name="phone_number" placeholder="+15085550123" />
              <Input label="AWS origination id / ARN" name="provider_identity_arn" placeholder="phone-…" />
              <label className="grid gap-1.5 text-sm font-bold">Type
                <select className={select} defaultValue="" name="identity_type"><option value="">(unchanged)</option>{["long_code", "ten_dlc", "toll_free", "short_code"].map((value) => <option key={value} value={value}>{value}</option>)}</select>
              </label>
              <label className="grid gap-1.5 text-sm font-bold">Number status
                <select className={select} defaultValue="" name="identity_status"><option value="">(unchanged)</option>{["pending", "active", "suspended", "retired"].map((value) => <option key={value} value={value}>{value}</option>)}</select>
              </label>
              <label className="grid gap-1.5 text-sm font-bold">Default
                <select className={select} defaultValue="" name="identity_default"><option value="">(unchanged)</option><option value="yes">Make default</option><option value="no">Not default</option></select>
              </label>
            </fieldset>
            <Input className="md:col-span-2" label="Reason (recorded in both audit logs)" maxLength={500} minLength={5} name="reason" required />
            <div className="flex items-end"><Button variant="brand">Save messaging</Button></div>
          </form>
        </Card>
      ) : null}

      {messaging.can_manage && !confirming && connection?.dispatch_mode === "platform" ? (
        <Card className="mt-6 p-5">
          <h2 className="text-xl font-black">Move old-CRM automations to the platform</h2>
          <p className="mt-1 text-sm text-wayne-muted">Automations mirrored from the old Hanafy CRM are only shown until this step. After it, the platform worker runs them (each one still has to be switched on). Pause them in the old CRM first so no customer gets two texts.</p>
          <form action={adoptLegacyAutomations} className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <input name="workspace" type="hidden" value={workspace.slug} />
            <Input label="Reason" minLength={5} name="reason" required />
            <Button variant="danger">Move automations</Button>
            <label className="flex items-center gap-2 text-sm font-bold md:col-span-2"><input name="confirmed" type="checkbox" value="yes" /> The old CRM automations for {workspace.name} are paused.</label>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
