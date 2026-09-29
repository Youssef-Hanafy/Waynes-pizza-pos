import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Flash, first, when } from "@/components/platform/format";
import { requirePermission } from "@/lib/auth/access";
import { getCampaignAudience, getMarketingOverview, workspaceTimezone } from "@/lib/messaging/queries";
import { campaignPlaceholders, skipReasonLabels } from "@/lib/messaging/schemas";
import { cancelCampaign, saveCampaign, sendCampaign, sendTestText } from "../../actions";

export const metadata: Metadata = { title: "Campaign" };
export const dynamic = "force-dynamic";

/** One campaign: edit the draft, preview who gets it, test, then send or schedule. */
export default async function CampaignPage({ params, searchParams }: { params: Promise<{ campaignId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await requirePermission("campaigns.view", "/admin/marketing");
  const slug = access.workspace_slug ?? "";
  const [{ campaignId }, query] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/.test(campaignId)) notFound();
  const [overview, audience, tz] = await Promise.all([getMarketingOverview(slug), getCampaignAudience(slug, campaignId), workspaceTimezone(slug)]);
  const campaign = overview.campaigns.find((item) => item.id === campaignId);
  if (!campaign) notFound();
  const draft = campaign.status === "draft";
  const legacy = overview.connection?.dispatch_mode === "legacy_crm_bridge";
  const messages = overview.recent_messages.filter((message) => message.campaign_id === campaign.id);

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <Link className="text-sm font-bold text-wayne-muted hover:underline" href="/admin/marketing">← Campaigns</Link>
      <div className="mt-3 flex flex-wrap items-center gap-3"><h1 className="text-4xl font-black">{campaign.name}</h1><Badge tone={campaign.status === "sent" ? "ok" : campaign.status === "draft" ? "neutral" : "warn"}>{campaign.status}</Badge></div>
      <Flash error={first(query.error)} saved={first(query.saved)} />

      <div className="mt-6 grid gap-4 md:grid-cols-4">
        <Card className="p-4"><p className="text-sm text-wayne-muted">Would receive it</p><strong className="text-3xl">{audience?.eligible ?? "—"}</strong></Card>
        <Card className="p-4"><p className="text-sm text-wayne-muted">Skipped</p><strong className="text-3xl">{audience ? audience.total - audience.eligible : "—"}</strong></Card>
        <Card className="p-4"><p className="text-sm text-wayne-muted">Sent</p><strong className="text-3xl">{campaign.messages_sent}</strong></Card>
        <Card className="p-4"><p className="text-sm text-wayne-muted">Failed</p><strong className="text-3xl">{campaign.messages_failed}</strong></Card>
      </div>
      {audience && Object.keys(audience.skipped).length ? (
        <p className="mt-3 text-sm text-wayne-muted">Skipped because: {Object.entries(audience.skipped).map(([reason, count]) => `${skipReasonLabels[reason] ?? reason} (${count})`).join(", ")}.</p>
      ) : null}

      <Card className="mt-6 p-5">
        <h2 className="text-xl font-black">Message</h2>
        {draft && overview.can_manage ? (
          <form action={saveCampaign} className="mt-4 grid gap-4">
            <input name="id" type="hidden" value={campaign.id} />
            <Input defaultValue={campaign.name} label="Campaign name" maxLength={120} name="name" required />
            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-bold">Who gets it
                <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue={campaign.audience_type} name="audience_type">
                  <option value="all_subscribers">All text subscribers</option><option value="segment">A segment</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-bold">Segment
                <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue={campaign.segment_id ?? ""} name="segment_id">
                  <option value="">—</option>
                  {overview.segments.map((segment) => <option key={segment.id} value={segment.id}>{segment.name} ({segment.members})</option>)}
                </select>
              </label>
            </div>
            <label className="grid gap-1.5 text-sm font-bold">Text
              <textarea className="min-h-28 rounded-xl border border-wayne-border bg-white p-3 font-normal" defaultValue={campaign.body} maxLength={1600} name="body" required />
              <span className="text-xs font-normal text-wayne-muted">{campaign.body.length} characters · fills in {campaignPlaceholders.join(", ")}</span>
            </label>
            <div><Button type="submit" variant="secondary">Save changes</Button></div>
          </form>
        ) : (
          <p className="mt-3 whitespace-pre-wrap rounded-xl bg-wayne-cream p-4">{campaign.body}</p>
        )}
      </Card>

      {overview.can_manage && (draft || campaign.status === "scheduled") ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {draft ? (
            <Card className="p-5">
              <h2 className="text-xl font-black">Send a test</h2>
              <p className="mt-1 text-sm text-wayne-muted">Goes to one phone with [TEST] in front. Up to 10 per campaign.</p>
              <form action={sendTestText} className="mt-4 grid gap-3">
                <input name="id" type="hidden" value={campaign.id} />
                <Input label="Your mobile number" name="phone" placeholder="(508) 555-0123" required />
                <div><Button disabled={legacy} type="submit" variant="secondary">Send test</Button></div>
              </form>
            </Card>
          ) : null}
          <Card className="p-5">
            <h2 className="text-xl font-black">{draft ? "Send or schedule" : "Scheduled"}</h2>
            {draft ? (
              legacy ? (
                <p className="mt-2 text-sm">This business still sends from the Hanafy CRM, so this campaign can&apos;t be sent here yet.</p>
              ) : (
                <form action={sendCampaign} className="mt-4 grid gap-3">
                  <input name="id" type="hidden" value={campaign.id} /><input name="timezone" type="hidden" value={tz} />
                  <Input hint={`Leave empty to send now. Times are ${tz}.`} label="Send at (optional)" name="send_at" type="datetime-local" />
                  <label className="flex items-center gap-2 text-sm font-bold"><input name="confirm" type="checkbox" value="yes" /> Send to {audience?.eligible ?? 0} customers</label>
                  <div><Button type="submit">Send campaign</Button></div>
                </form>
              )
            ) : (
              <p className="mt-2 text-sm">Goes out {when(campaign.scheduled_at, tz)}.</p>
            )}
          </Card>
        </div>
      ) : null}

      {overview.can_manage && ["draft", "scheduled", "sending"].includes(campaign.status) ? (
        <form action={cancelCampaign} className="mt-4"><input name="id" type="hidden" value={campaign.id} /><Button variant="ghost">Cancel campaign</Button></form>
      ) : null}

      {messages.length ? (
        <section className="mt-8">
          <h2 className="text-xl font-black">Latest texts</h2>
          <ul className="mt-3 grid gap-1 text-sm">
            {messages.map((message) => <li key={message.id}>…{message.recipient_last4}{message.is_test ? " (test)" : ""}: {message.status}{message.simulated ? " (test mode)" : ""}{message.skip_reason ? ` — ${skipReasonLabels[message.skip_reason] ?? message.skip_reason}` : ""}</li>)}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
