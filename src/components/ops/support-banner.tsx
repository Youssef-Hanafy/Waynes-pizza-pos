import Link from "next/link";
import { endSupportSession } from "@/app/platform/actions";
import type { CurrentAccess } from "@/lib/auth/permissions";

function endsAt(expiresAt: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(expiresAt));
}

/**
 * Shown on every screen while Hanafy staff work inside a business through a
 * support session (build sheet §8.4: never invisible).  `compact` is a small
 * fixed pill for the full-screen register, kitchen and driver screens.
 */
export function SupportBanner({
  workspaceName,
  workspaceSlug,
  expiresAt,
  timeZone = "America/New_York",
  compact = false,
}: {
  workspaceName: string;
  workspaceSlug: string;
  expiresAt: string;
  timeZone?: string;
  compact?: boolean;
}) {
  const returnTo = `/platform/workspaces/${workspaceSlug}`;
  if (compact) {
    return (
      <div className="fixed bottom-3 right-3 z-[60] flex items-center gap-2 rounded-full bg-wayne-ink px-4 py-2 text-xs font-bold text-white shadow-lg" role="status">
        <span>Hanafy support · {workspaceName} · ends {endsAt(expiresAt, timeZone)}</span>
        <form action={endSupportSession}>
          <input name="return_to" type="hidden" value={returnTo} />
          <button className="rounded-full bg-white/15 px-2.5 py-1 underline-offset-2 hover:underline" type="submit">End</button>
        </form>
      </div>
    );
  }
  return (
    <div className="bg-wayne-ink px-5 py-2 text-sm text-white" role="status">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1">
        <strong>Viewing {workspaceName} as Hanafy Platform support.</strong>
        <span className="text-white/80">Everything you change is recorded in this business&apos;s audit log. Session ends at {endsAt(expiresAt, timeZone)}.</span>
        <span className="ml-auto flex items-center gap-3">
          <Link className="font-bold underline underline-offset-2" href={returnTo}>Platform Admin</Link>
          <form action={endSupportSession}>
            <input name="return_to" type="hidden" value={returnTo} />
            <button className="rounded-lg bg-white px-3 py-1 font-bold text-wayne-ink" type="submit">End support session</button>
          </form>
        </span>
      </div>
    </div>
  );
}

/** The compact banner for full-screen staff screens, when the access is a support session. */
export function SupportPill({ access }: { access: CurrentAccess }) {
  if (!access.support_session || !access.workspace_slug) return null;
  return <SupportBanner compact expiresAt={access.support_session.expires_at} workspaceName={access.workspace_name ?? "this business"} workspaceSlug={access.workspace_slug} />;
}
