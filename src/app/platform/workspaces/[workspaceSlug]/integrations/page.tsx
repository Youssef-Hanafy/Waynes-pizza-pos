import type { Metadata } from "next";
import { z } from "zod";
import { savePaymentConnection, testWorkspacePaymentConnection } from "../../../actions";
import { Flash, first, when } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { connectionStatusLabels } from "@/lib/platform/integrations";
import { getPlatformWorkspace, getPlatformWorkspaceIntegrations } from "@/lib/platform/queries";

export const metadata: Metadata = { title: "Payments & integrations" };
export const dynamic = "force-dynamic";

const pendingSchema = z.object({
  confirm: z.literal("payment"),
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

const statusTone = (status: string) =>
  status === "connected" || status === "active" ? "ok" : status === "manual" ? "brand" : status === "error" ? "alert" : status === "disabled" || status === "not_configured" ? "neutral" : "warn";

const capabilityLabels: Record<string, string> = {
  online_card: "Online card",
  card_present: "Card at the counter",
  card_present_integrated: "POS drives the reader",
  manual_confirmation: "Staff confirm by hand",
  refunds_via_api: "Refunds from the POS",
  voids_via_api: "Voids from the POS",
  webhooks: "Provider webhooks",
};

const select = "min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal";

/**
 * Payments & integrations tab (§11.3 Payments, §24).  Connection metadata
 * only: no card data exists anywhere in Hanafy, and secrets appear only as
 * the name of the server setting that holds them.
 */
export default async function PlatformWorkspaceIntegrationsPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const [workspace, data] = await Promise.all([getPlatformWorkspace(workspaceSlug), getPlatformWorkspaceIntegrations(workspaceSlug)]);
  const pending = pendingSchema.safeParse(Object.fromEntries(["confirm", "reason", "pending_payload", "warnings"].map((key) => [key, first(query[key]) ?? ""])));
  const confirming = pending.success ? pending.data : null;
  const tz = workspace.timezone;

  return (
    <div className="mt-6">
      {confirming ? (
        <Card className="mt-2 border-wayne-alert/50 p-5">
          <h2 className="text-xl font-black">Confirm the payment change for {workspace.name}</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5">{confirming.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          <form action={savePaymentConnection} className="mt-4 flex flex-wrap gap-3">
            <input name="workspace" type="hidden" value={workspace.slug} />
            <input name="reason" type="hidden" value={confirming.reason} />
            <input name="pending_payload" type="hidden" value={confirming.pending_payload} />
            <input name="confirmed" type="hidden" value="yes" />
            <Button variant="danger">Yes, make this change</Button>
            <Button asChild variant="secondary"><a href={`/platform/workspaces/${workspace.slug}/integrations`}>Cancel</a></Button>
          </form>
        </Card>
      ) : (
        <Flash error={first(query.error)} saved={first(query.saved)} />
      )}

      <div className="mt-2 grid gap-4 md:grid-cols-3">
        <Card className="p-5"><p className="text-sm text-wayne-muted">Last captured card payment</p><strong className="mt-1 block text-xl">{when(data.last_card_payment_at, tz)}</strong></Card>
        <Card className="p-5"><p className="text-sm text-wayne-muted">Webhook problems (7 days)</p><strong className={`mt-1 block text-3xl ${data.webhook_problems_7d ? "text-wayne-alert" : ""}`}>{data.webhook_problems_7d}</strong></Card>
        <Card className="p-5"><p className="text-sm text-wayne-muted">Who holds the money</p><strong className="mt-1 block">The business&apos;s own processor</strong><p className="text-xs text-wayne-muted">Hanafy is never the merchant of record and never sees card numbers.</p></Card>
      </div>

      <h2 className="mt-8 text-2xl font-black">Payment connections</h2>
      <div className="mt-3 grid gap-3">
        {data.payment_connections.map((connection) => (
          <Card className="p-5" key={connection.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <strong className="text-lg">{connection.provider_name}</strong>
                <span className="ml-2 text-sm text-wayne-muted">{connection.purpose.replaceAll("_", " ")} · {connection.connection_mode.replace("_", " ")} · {connection.environment}{connection.location_name ? ` · ${connection.location_name}` : ""}</span>
              </div>
              <Badge tone={statusTone(connection.status)}>{connectionStatusLabels[connection.status] ?? connection.status}</Badge>
            </div>
            <div className="mt-3 grid gap-1 text-sm md:grid-cols-2">
              <p>Merchant / account: <strong>{connection.merchant_reference ?? "—"}</strong></p>
              <p>Credentials: <strong>{connection.secret_reference ?? (connection.connection_mode === "manual_external" ? "none needed" : "not set")}</strong></p>
              <p>Tested: <strong>{connection.verified_at ? when(connection.verified_at, tz) : "never"}</strong>{connection.verification_note ? ` — ${connection.verification_note}` : ""}</p>
              <p>Last success: <strong>{when(connection.last_success_at, tz)}</strong></p>
              {connection.webhook_path ? <p className="md:col-span-2">Webhook URL: <code className="select-all break-all">https://&lt;app host&gt;{connection.webhook_path}</code></p> : null}
              {connection.last_error_summary ? <p className="text-wayne-alert md:col-span-2">Last error {when(connection.last_error_at, tz)}: {connection.last_error_summary}</p> : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {Object.entries(connection.capabilities).map(([key, on]) => <Badge key={key} tone={on ? "ok" : "neutral"}>{on ? "✓" : "✗"} {capabilityLabels[key] ?? key}</Badge>)}
            </div>
            {connection.terminals.length ? (
              <p className="mt-3 text-sm">Terminals: {connection.terminals.map((terminal) => `${terminal.label} (${terminal.type === "external_manual" ? "run by hand" : "POS reader"}, ${terminal.status})`).join("; ")}</p>
            ) : null}
            {data.can_manage && !confirming ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {connection.connection_mode !== "manual_external" && connection.status !== "disabled" ? (
                  <form action={testWorkspacePaymentConnection}>
                    <input name="workspace" type="hidden" value={workspace.slug} /><input name="id" type="hidden" value={connection.id} />
                    <Button size="sm" variant="secondary">Test connection</Button>
                  </form>
                ) : null}
                {connection.status !== "disabled" ? (
                  <form action={savePaymentConnection} className="flex flex-wrap items-end gap-2">
                    <input name="workspace" type="hidden" value={workspace.slug} /><input name="id" type="hidden" value={connection.id} /><input name="status" type="hidden" value="disabled" />
                    <Input label="Reason to turn off" minLength={5} name="reason" required />
                    <Button size="sm" variant="ghost">Turn off</Button>
                  </form>
                ) : null}
              </div>
            ) : null}
          </Card>
        ))}
        {data.payment_connections.length === 0 ? <Card className="p-5 text-wayne-muted">No payment connection. Card payment is unavailable for this business until one is added.</Card> : null}
      </div>

      {data.can_manage && !confirming ? (
        <Card className="mt-6 p-5">
          <h2 className="text-xl font-black">Add a payment connection</h2>
          <p className="mt-1 text-sm text-wayne-muted">Planned providers can be recorded but never connected. API connections show connected only after &quot;Test connection&quot; succeeds with the real provider.</p>
          <form action={savePaymentConnection} className="mt-4 grid gap-4 md:grid-cols-3">
            <input name="workspace" type="hidden" value={workspace.slug} />
            <label className="grid gap-1.5 text-sm font-bold">Provider
              <select className={select} defaultValue="manual_external" name="provider">
                {data.providers.map((provider) => <option key={provider.code} value={provider.code}>{provider.name}{provider.availability === "planned" ? " (planned)" : ""}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-bold">Used for
              <select className={select} defaultValue="counter" name="purpose"><option value="counter">Counter (POS)</option><option value="online">Online ordering</option><option value="counter_and_online">Both</option></select>
            </label>
            <label className="grid gap-1.5 text-sm font-bold">Mode
              <select className={select} defaultValue="" name="connection_mode"><option value="">Provider default</option><option value="api">API</option><option value="terminal_api">Terminal API</option><option value="manual_external">Manual external terminal</option></select>
            </label>
            <label className="grid gap-1.5 text-sm font-bold">Location
              <select className={select} defaultValue={data.locations[0]?.id ?? ""} name="location_id"><option value="">Whole business</option>{data.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select>
            </label>
            <label className="grid gap-1.5 text-sm font-bold">Environment
              <select className={select} defaultValue="sandbox" name="environment"><option value="sandbox">Sandbox</option><option value="production">Production</option></select>
            </label>
            <Input label="Merchant / processor name" name="merchant_reference" placeholder="Boston North, or the Square location id" />
            <Input label="Credentials reference (API only)" name="secret_reference" placeholder="env:SQUARE_WAYNES" />
            <Input label="Application id (API only)" name="config_application_id" />
            <Input label="Provider location id (API only)" name="config_provider_location_id" />
            <Input label="Webhook notification URL (API only)" name="config_notification_url" placeholder="https://…/api/payments/webhooks/…" />
            <Input label="Terminal name (manual)" name="terminal_label" placeholder="Counter card terminal" />
            <Input label="Reason" minLength={5} name="reason" required />
            <div className="md:col-span-3"><Button variant="brand">Save payment connection</Button></div>
          </form>
        </Card>
      ) : null}

      <h2 className="mt-8 text-2xl font-black">All integrations</h2>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead><tr className="text-wayne-muted"><th className="py-2">Type</th><th>Name</th><th>Provider</th><th>Status</th><th>Last success</th><th>Last error</th></tr></thead>
          <tbody>
            {data.integrations.map((item) => (
              <tr className="border-t border-wayne-border/60" key={item.id}>
                <td className="py-2">{item.type.replace("_", " ")}</td>
                <td>{item.name}</td>
                <td><code>{item.provider}</code></td>
                <td><Badge tone={statusTone(item.status)}>{connectionStatusLabels[item.status] ?? item.status}</Badge></td>
                <td>{when(item.last_success_at, tz)}</td>
                <td>{item.last_error_summary ? `${when(item.last_error_at, tz)} — ${item.last_error_summary}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 text-xl font-black">Provider catalog</h2>
      <div className="mt-3 grid gap-2 md:grid-cols-3">
        {data.providers.map((provider) => (
          <Card className="p-4 text-sm" key={provider.code}>
            <strong>{provider.name}</strong> <Badge tone={provider.availability === "available" ? "ok" : "neutral"}>{provider.availability}</Badge>
            <p className="mt-2 text-wayne-muted">{provider.description}</p>
          </Card>
        ))}
      </div>
    </div>
  );
}
