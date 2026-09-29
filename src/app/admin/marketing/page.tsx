import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Flash, first, when } from "@/components/platform/format";
import { requirePermission } from "@/lib/auth/access";
import { HANAFY_CRM_CONSOLE_URL } from "@/lib/tenancy/navigation";
import { getMarketingOverview, workspaceTimezone } from "@/lib/messaging/queries";
import { campaignPlaceholders, skipReasonLabels, type Campaign } from "@/lib/messaging/schemas";
import { saveCampaign, saveTemplate, setSuppression } from "./actions";

export const metadata: Metadata = { title: "Campaigns" };
export const dynamic = "force-dynamic";

const statusTone: Record<Campaign["status"], "ok" | "warn" | "alert" | "neutral" | "brand"> = {
  draft: "neutral", scheduled: "warn", sending: "brand", sent: "ok", cancelled: "neutral", failed: "alert",
};

/**
 * Campaign Manager (build sheet §17.1), workspace-scoped.  Every read and
 * write goes through RPCs that re-check the signed-in user's workspace and
 * permission; the page never sends a workspace id.
 */
export default async function MarketingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await requirePermission("campaigns.view", "/admin/marketing");
  const slug = access.workspace_slug ?? "";
  const [query, overview, tz] = await Promise.all([searchParams, getMarketingOverview(slug), workspaceTimezone(slug)]);
  const legacy = overview.connection?.dispatch_mode === "legacy_crm_bridge";
  const sender = overview.senders.find((item) => item.is_default && item.status === "active") ?? null;

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Marketing</p>
      <h1 className="mt-3 text-4xl font-black">Campaigns</h1>
      <p className="mt-3 max-w-3xl text-wayne-muted">
        One-time texts to your subscribers or a segment. Only customers who agreed to texts are included, anyone who replied STOP is skipped, and every text goes out from this business&apos;s own number.
      </p>
      <Flash error={first(query.error)} saved={first(query.saved)} />

      <div className="mt-7 grid gap-4 md:grid-cols-3">
        <Card className="p-5">
          <p className="text-sm text-wayne-muted">Sending number</p>
          <strong className="mt-1 block text-2xl">{sender?.phone_number ?? "None yet"}</strong>
          <p className="mt-2 text-sm text-wayne-muted">
            {!overview.connection ? "Hanafy has not set up texting for this business yet." :
              legacy ? "Texts currently go out from the Hanafy CRM." :
              overview.connection.live_sending ? "Live: texts are delivered through AWS." : "Test mode: texts are recorded but not delivered."}
          </p>
        </Card>
        <Card className="p-5"><p className="text-sm text-wayne-muted">Text subscribers</p><strong className="mt-1 block text-3xl">{overview.subscribers}</strong></Card>
        <Card className="p-5"><p className="text-sm text-wayne-muted">Opted out</p><strong className="mt-1 block text-3xl">{overview.suppressed}</strong></Card>
      </div>

      {legacy ? (
        <Card className="mt-5 border-wayne-warn/40 bg-wayne-warn-soft p-5">
          <strong>This business still sends its texts from the Hanafy CRM.</strong>{" "}
          Campaigns can be drafted and tested here, but sending stays in the{" "}
          <a className="font-bold underline" href={HANAFY_CRM_CONSOLE_URL} rel="noreferrer" target="_blank">Hanafy CRM console</a>{" "}
          until Hanafy switches texting to the platform, so no customer ever gets the same text twice.
        </Card>
      ) : null}

      <section className="mt-10">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-2xl font-black">Campaigns</h2>
        </div>
        <div className="mt-4 grid gap-3">
          {overview.campaigns.map((campaign) => (
            <Link href={`/admin/marketing/campaigns/${campaign.id}`} key={campaign.id}>
              <Card className="flex flex-wrap items-center justify-between gap-3 p-4 transition hover:border-wayne-border-strong">
                <div>
                  <strong>{campaign.name}</strong>
                  <p className="text-sm text-wayne-muted">
                    {campaign.audience_type === "segment" ? `Segment: ${overview.segments.find((segment) => segment.id === campaign.segment_id)?.name ?? "—"}` : "All text subscribers"}
                    {" · "}{campaign.status === "draft" ? `created ${when(campaign.created_at, tz)}` : campaign.status === "scheduled" ? `goes out ${when(campaign.scheduled_at, tz)}` : `${campaign.messages_sent} sent, ${campaign.recipients_skipped} skipped, ${campaign.messages_failed} failed`}
                  </p>
                </div>
                <Badge tone={statusTone[campaign.status]}>{campaign.status}</Badge>
              </Card>
            </Link>
          ))}
          {overview.campaigns.length === 0 ? <Card className="p-6 text-wayne-muted">No campaigns yet.</Card> : null}
        </div>

        {overview.can_manage ? (
          <details className="mt-5" open={overview.campaigns.length === 0}>
            <summary className="cursor-pointer text-lg font-black">New campaign</summary>
            <Card className="mt-3 p-5">
              <form action={saveCampaign} className="grid gap-4">
                <Input label="Campaign name" maxLength={120} name="name" placeholder="Tuesday large pizza deal" required />
                <div className="grid gap-4 md:grid-cols-2">
                  <label className="grid gap-1.5 text-sm font-bold">Who gets it
                    <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue="all_subscribers" name="audience_type">
                      <option value="all_subscribers">All text subscribers ({overview.subscribers})</option>
                      <option value="segment">A segment (pick below)</option>
                    </select>
                  </label>
                  <label className="grid gap-1.5 text-sm font-bold">Segment
                    <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue="" name="segment_id">
                      <option value="">—</option>
                      {overview.segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name} ({segment.members})</option>)}
                    </select>
                  </label>
                </div>
                <label className="grid gap-1.5 text-sm font-bold">Start from a template (optional)
                  <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue="" name="template_id">
                    <option value="">—</option>
                    {overview.templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm font-bold">Message
                  <textarea className="min-h-28 rounded-xl border border-wayne-border bg-white p-3 font-normal" maxLength={1600} name="body" placeholder="{{business_name}}: Hi {{first_name}}, large 1-topping $12.99 today only! Reply STOP to opt out" />
                  <span className="text-xs font-normal text-wayne-muted">Fills in per customer: {campaignPlaceholders.join(", ")}. Include &quot;Reply STOP to opt out&quot;.</span>
                </label>
                <div><Button type="submit">Save draft</Button></div>
              </form>
            </Card>
          </details>
        ) : null}
      </section>

      <section className="mt-10">
        <h2 className="text-2xl font-black">Templates</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {overview.templates.map((template) => (
            <Card className="p-4" key={template.id}>
              <strong>{template.name}</strong>
              <p className="mt-2 whitespace-pre-wrap text-sm">{template.body}</p>
              {overview.can_manage ? (
                <form action={saveTemplate} className="mt-3">
                  <input name="id" type="hidden" value={template.id} /><input name="name" type="hidden" value={template.name} /><input name="body" type="hidden" value={template.body} />
                  <input name="archive" type="hidden" value="yes" />
                  <Button size="sm" variant="secondary">Archive</Button>
                </form>
              ) : null}
            </Card>
          ))}
          {overview.templates.length === 0 ? <Card className="p-5 text-wayne-muted md:col-span-2">No templates yet.</Card> : null}
        </div>
        {overview.can_manage ? (
          <details className="mt-4">
            <summary className="cursor-pointer font-black">New template</summary>
            <Card className="mt-3 p-5">
              <form action={saveTemplate} className="grid gap-4">
                <Input label="Template name" maxLength={120} name="name" required />
                <label className="grid gap-1.5 text-sm font-bold">Message
                  <textarea className="min-h-24 rounded-xl border border-wayne-border bg-white p-3 font-normal" maxLength={1600} name="body" required />
                </label>
                <div><Button type="submit" variant="secondary">Save template</Button></div>
              </form>
            </Card>
          </details>
        ) : null}
      </section>

      {overview.can_manage_suppressions ? (
        <section className="mt-10">
          <h2 className="text-2xl font-black">Opted out</h2>
          <p className="mt-2 max-w-3xl text-sm text-wayne-muted">These numbers never get texts from this business: campaigns and automations skip them. A customer who replies START is removed from this list automatically.</p>
          <div className="mt-4 grid gap-2">
            {overview.suppressions.map((entry) => (
              <Card className="flex flex-wrap items-center justify-between gap-3 p-4" key={entry.id}>
                <div><strong>{entry.address}</strong><p className="text-sm text-wayne-muted">{entry.reason.replace("_", " ")} · {when(entry.created_at, tz)}{entry.note ? ` · ${entry.note}` : ""}</p></div>
                <form action={setSuppression} className="flex flex-wrap items-end gap-2">
                  <input name="action" type="hidden" value="lift" /><input name="id" type="hidden" value={entry.id} />
                  <Input label="Why remove?" name="reason" placeholder="Customer asked to be texted again" required />
                  <Button size="sm" variant="secondary">Remove opt-out</Button>
                </form>
              </Card>
            ))}
          </div>
          <Card className="mt-3 p-5">
            <form action={setSuppression} className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
              <input name="action" type="hidden" value="add" />
              <Input label="Mobile number" name="address" placeholder="(508) 555-0123" required />
              <Input label="Note" name="note" placeholder="Asked in store not to be texted" />
              <Button variant="danger">Opt out</Button>
            </form>
          </Card>
        </section>
      ) : null}

      <section className="mt-10">
        <h2 className="text-2xl font-black">Recent texts</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr className="text-wayne-muted"><th className="py-2">When</th><th>To</th><th>Type</th><th>Status</th></tr></thead>
            <tbody>
              {overview.recent_messages.map((message) => (
                <tr className="border-t border-wayne-border/60" key={message.id}>
                  <td className="py-2">{when(message.sent_at ?? message.created_at, tz)}</td>
                  <td>…{message.recipient_last4}{message.is_test ? " (test)" : ""}</td>
                  <td>{message.campaign_id ? "Campaign" : message.automation_run_id ? "Automation" : message.message_type}</td>
                  <td>{message.status}{message.simulated ? " (test mode)" : ""}{message.skip_reason ? ` — ${skipReasonLabels[message.skip_reason] ?? message.skip_reason}` : ""}{message.last_error ? ` — ${message.last_error}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {overview.recent_messages.length === 0 ? <p className="py-4 text-wayne-muted">Nothing sent from the platform yet.</p> : null}
        </div>
      </section>
    </main>
  );
}
