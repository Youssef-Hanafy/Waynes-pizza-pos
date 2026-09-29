import Link from "next/link";
import { notFound } from "next/navigation";
import { endSupportSession, startSupportSession } from "../../actions";
import { HealthBadge, when, WorkspaceStatus } from "@/components/platform/format";
import { PlatformTabs } from "@/components/platform/platform-tabs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getPlatformWorkspace, requirePlatformUser } from "@/lib/platform/queries";
import { workspaceSlugSchema } from "@/lib/tenancy/schemas";

/**
 * Workspace detail inside Platform Admin (§11.3).  Viewing here never opens
 * the business's data; acting inside the business needs a support session,
 * started below with a reason and recorded in both audit logs.
 */
export default async function PlatformWorkspaceLayout({ children, params }: Readonly<{ children: React.ReactNode; params: Promise<{ workspaceSlug: string }> }>) {
  const { workspaceSlug } = await params;
  if (!workspaceSlugSchema.safeParse(workspaceSlug).success) notFound();
  const [me, workspace] = await Promise.all([requirePlatformUser(), getPlatformWorkspace(workspaceSlug)]);
  const base = `/platform/workspaces/${workspace.slug}`;
  const inThisOne = me.support_session?.workspace_id === workspace.id ? me.support_session : null;

  return (
    <main className="mx-auto max-w-7xl px-5 py-10">
      <Link className="text-sm font-bold text-wayne-muted hover:underline" href="/platform/workspaces">← Businesses</Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-4xl font-black">{workspace.name}</h1>
        <WorkspaceStatus status={workspace.status} />
        <HealthBadge level={workspace.health.level} />
      </div>
      <p className="mt-2 text-sm text-wayne-muted">
        <code>{workspace.slug}</code> · <code className="select-all">{workspace.id}</code> · {workspace.timezone} · on the platform since {when(workspace.created_at, workspace.timezone)}
      </p>

      <Card className="mt-6 p-5">
        {inThisOne ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p><strong>You are in a support session for {workspace.name}</strong> until {when(inThisOne.expires_at, workspace.timezone)}. <span className="text-wayne-muted">Reason: {inThisOne.reason}</span></p>
            <div className="flex gap-2">
              <Button asChild variant="brand"><a href={`/w/${workspace.slug}`}>Open {workspace.name}</a></Button>
              <form action={endSupportSession}><input name="return_to" type="hidden" value={base} /><Button variant="secondary">End session</Button></form>
            </div>
          </div>
        ) : me.can_support ? (
          <details>
            <summary className="cursor-pointer font-bold">Enter {workspace.name} as Hanafy support</summary>
            <p className="mt-2 max-w-3xl text-sm text-wayne-muted">
              Hanafy staff have no access to a business&apos;s orders, customers or settings except during a support session.
              The business sees who entered, when and why, and everything you change is marked as done by Hanafy support.
              {me.platform_role === "platform_support" ? " Your role can look but not change anything." : ""}
            </p>
            <form action={startSupportSession} className="mt-4 grid gap-4 md:grid-cols-[1fr_14rem_10rem_auto] md:items-end">
              <input name="workspace" type="hidden" value={workspace.slug} />
              <Input id="support-reason" label="Why are you entering?" maxLength={500} minLength={5} name="reason" placeholder="Owner asked us to fix the large pizza price" required />
              <Input id="support-ticket" label="Ticket or reference" maxLength={120} name="ticket" placeholder="Optional" />
              <label className="grid gap-1.5 text-sm font-bold">For
                <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue="60" name="minutes">
                  <option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">1 hour</option><option value="120">2 hours</option><option value="240">4 hours</option><option value="480">8 hours</option>
                </select>
              </label>
              <Button variant="brand">Start support session</Button>
            </form>
          </details>
        ) : (
          <p className="text-sm text-wayne-muted">Your platform role can view this business here but cannot enter it.</p>
        )}
      </Card>

      <div className="mt-6">
        <PlatformTabs exact={[base]} label={`${workspace.name} sections`} tabs={[[base, "Overview"], [`${base}/services`, "Services"], [`${base}/users`, "Users"], [`${base}/messaging`, "Messaging"], [`${base}/integrations`, "Payments & integrations"], [`${base}/hardware`, "Hardware"], [`${base}/health`, "Health"], [`${base}/audit`, "Audit"]]} />
      </div>
      {children}
    </main>
  );
}
