import type { Metadata } from "next";
import Link from "next/link";
import { when } from "@/components/platform/format";
import { Card } from "@/components/ui/card";
import { getPlatformAudit } from "@/lib/platform/queries";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

function show(value: unknown) {
  if (value === null || value === undefined) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Platform audit log (§29): every Platform Admin action. Entries cannot be edited or deleted. */
export default async function PlatformAuditPage() {
  const entries = await getPlatformAudit(300);
  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">Hanafy Platform</p>
      <h1 className="mt-3 text-4xl font-black">Audit log</h1>
      <p className="mt-3 max-w-3xl text-wayne-muted">Service changes, user changes and support sessions made from Platform Admin: who, when, why, and what changed. The newest 300 entries.</p>
      <div className="mt-6 grid gap-3">
        {entries.map((entry) => (
          <Card className="p-4" key={entry.id}>
            <strong className="block">{entry.summary}</strong>
            <span className="text-sm text-wayne-muted">
              {entry.actor_name}{entry.actor_role ? ` (${entry.actor_role.replace("platform_", "")})` : ""} · {when(entry.occurred_at)} · <code>{entry.action}</code>
              {entry.workspace_slug ? <> · <Link className="font-bold underline" href={`/platform/workspaces/${entry.workspace_slug}`}>{entry.workspace_name}</Link></> : null}
            </span>
            {entry.reason ? <p className="mt-1 text-sm">Reason: {entry.reason}</p> : null}
            {entry.before_data || entry.after_data ? (
              <p className="mt-1 break-words text-xs text-wayne-muted">{show(entry.before_data)} → {show(entry.after_data)}</p>
            ) : null}
          </Card>
        ))}
        {entries.length === 0 ? <Card className="p-8 text-center text-wayne-muted">No platform actions yet.</Card> : null}
      </div>
    </main>
  );
}
