import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { setWorkspaceStatus } from "../../../actions";
import { Flash, first } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getPlatformWorkspace, getPlatformWorkspaceSetup } from "@/lib/platform/queries";

export const metadata: Metadata = { title: "Setup" };
export const dynamic = "force-dynamic";

const pendingSchema = z.object({
  confirm: z.enum(["active", "suspended", "archived"]),
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

const stepNames: Record<number, string> = { 1: "Business", 2: "Location", 3: "Services", 4: "Owner", 5: "Messaging", 6: "Payments", 7: "Hardware", 8: "Data import", 9: "Go-live" };
const tone = { pass: "ok", fail: "alert", optional: "neutral" } as const;

/**
 * Setup tab (§25 steps 4-10): the validation checklist from real records,
 * links to the tab that fixes each item, and activation — only when every
 * required item passes.  Suspend / archive (§39) live here too.
 */
export default async function PlatformWorkspaceSetupPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const [workspace, setup] = await Promise.all([getPlatformWorkspace(workspaceSlug), getPlatformWorkspaceSetup(workspaceSlug)]);
  const base = `/platform/workspaces/${workspace.slug}`;
  const pending = pendingSchema.safeParse(Object.fromEntries(["confirm", "reason", "warnings"].map((key) => [key, first(query[key]) ?? ""])));
  const confirming = pending.success ? pending.data : null;

  return (
    <div className="mt-6">
      {confirming ? (
        <Card className="mt-2 border-wayne-alert/50 p-5">
          <h2 className="text-xl font-black">Confirm: make {workspace.name} {confirming.confirm}</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5">{confirming.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          <form action={setWorkspaceStatus} className="mt-4 flex flex-wrap gap-3">
            <input name="workspace" type="hidden" value={workspace.slug} /><input name="status" type="hidden" value={confirming.confirm} />
            <input name="reason" type="hidden" value={confirming.reason} /><input name="confirmed" type="hidden" value="yes" />
            <Button variant={confirming.confirm === "active" ? "brand" : "danger"}>Yes, make it {confirming.confirm}</Button>
            <Button asChild variant="secondary"><a href={`${base}/setup`}>Cancel</a></Button>
          </form>
        </Card>
      ) : <Flash error={first(query.error)} saved={first(query.saved)} />}

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-black">Setup checklist</h2>
        {setup.is_test ? <Badge tone="warn">Test workspace</Badge> : null}
        <Badge tone={setup.status === "active" ? "ok" : setup.status === "provisioning" ? "warn" : "neutral"}>{setup.status}</Badge>
      </div>
      <p className="mt-1 max-w-3xl text-sm text-wayne-muted">Every line is checked against the real records each time this page loads. Required lines must pass before the business can go live.</p>

      <div className="mt-4 grid gap-2">
        {setup.items.map((item) => (
          <Card className="flex flex-wrap items-center justify-between gap-3 p-4" key={item.key}>
            <div className="flex items-start gap-3">
              <span className="mt-0.5 w-20 shrink-0 text-xs font-black uppercase tracking-wider text-wayne-muted">{item.step}. {stepNames[item.step] ?? ""}</span>
              <div>
                <strong>{item.label}</strong>{item.required ? null : <span className="ml-2 text-xs text-wayne-muted">optional</span>}
                {item.detail ? <p className="text-sm text-wayne-muted">{item.detail}</p> : null}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {item.status !== "pass" ? <Link className="text-sm font-bold underline" href={`${base}${item.tab}`}>Fix</Link> : null}
              <Badge tone={tone[item.status]}>{item.status === "pass" ? "Done" : item.status === "fail" ? (item.required ? "Needed" : "Check") : "Not needed"}</Badge>
            </div>
          </Card>
        ))}
      </div>

      {setup.can_manage ? (
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          {setup.status !== "active" && setup.status !== "archived" ? (
            <Card className="p-5">
              <h3 className="text-lg font-black">Go live</h3>
              {setup.can_activate ? (
                <form action={setWorkspaceStatus} className="mt-3 grid gap-3">
                  <input name="workspace" type="hidden" value={workspace.slug} /><input name="status" type="hidden" value="active" />
                  <Input label="Reason" minLength={5} name="reason" placeholder="Checklist complete, owner trained" required />
                  <div><Button variant="brand">Activate {workspace.name}</Button></div>
                </form>
              ) : (
                <p className="mt-2 text-sm">Still needed: <strong>{setup.blocking.join("; ")}</strong></p>
              )}
            </Card>
          ) : null}
          {setup.status !== "archived" ? (
            <Card className="p-5">
              <h3 className="text-lg font-black">Suspend or archive</h3>
              <p className="mt-1 text-sm text-wayne-muted">Suspending stops staff and the website but keeps everything; archiving is for test workspaces and closed clients.{setup.legacy ? " This business cannot be archived." : ""}</p>
              <form action={setWorkspaceStatus} className="mt-3 grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
                <input name="workspace" type="hidden" value={workspace.slug} />
                <label className="grid gap-1.5 text-sm font-bold">Make it
                  <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue="suspended" name="status">
                    {setup.status !== "suspended" ? <option value="suspended">Suspended</option> : null}
                    {setup.legacy ? null : <option value="archived">Archived</option>}
                  </select>
                </label>
                <Input label="Reason" minLength={5} name="reason" required />
                <Button variant="ghost">Continue</Button>
              </form>
            </Card>
          ) : <Card className="p-5 text-wayne-muted">This business is archived. Its records are kept; its web addresses are off.</Card>}
        </div>
      ) : null}
    </div>
  );
}
