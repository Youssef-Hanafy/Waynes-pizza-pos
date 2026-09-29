import Link from "next/link";
import { SupportBanner } from "@/components/ops/support-banner";
import { PlatformTabs } from "@/components/platform/platform-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requirePlatformUser } from "@/lib/platform/queries";
import { platformRoleLabels } from "@/lib/platform/schemas";
import { signOut } from "../admin/actions";

export const metadata = { title: { default: "Platform Admin", template: "%s · Hanafy Platform" }, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Hanafy Platform Admin (build sheet §11): Hanafy's internal console for the
 * businesses on the platform.  Only active platform staff get past the guard;
 * everyone else, business owners included, gets a 404.
 */
export default async function PlatformLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const me = await requirePlatformUser();
  return (
    <div className="flex min-h-screen flex-col bg-wayne-cream">
      {me.support_session ? (
        <SupportBanner expiresAt={me.support_session.expires_at} workspaceName={me.support_session.workspace_name} workspaceSlug={me.support_session.workspace_slug} />
      ) : null}
      <header className="border-b border-wayne-border bg-wayne-surface">
        <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center gap-5 px-5 py-2">
          <Link className="flex items-center gap-2.5" href="/platform">
            <span aria-hidden className="grid h-9 w-9 place-items-center rounded-lg bg-wayne-ink font-display text-sm font-black text-white">H</span>
            <span className="grid leading-tight">
              <span className="font-display text-base font-black tracking-tight">Hanafy Platform</span>
              <span className="text-[11px] font-bold uppercase tracking-widest text-wayne-muted">Platform Admin</span>
            </span>
          </Link>
          <PlatformTabs exact={["/platform"]} label="Platform Admin" tabs={[["/platform", "Dashboard"], ["/platform/workspaces", "Businesses"], ["/platform/billing", "Billing"], ["/platform/audit", "Audit log"]]} />
          <div className="ml-auto flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-bold leading-tight">{me.display_name}</p>
              <Badge className="mt-0.5" tone="neutral">{platformRoleLabels[me.platform_role]}</Badge>
            </div>
            <form action={signOut}><Button size="sm" variant="secondary">Sign out</Button></form>
          </div>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
