import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SupportBanner } from "@/components/ops/support-banner";
import { WorkspaceScope } from "@/components/ops/workspace-scope";
import { Badge } from "@/components/ui/badge";
import { buildWorkspaceNavigation } from "@/lib/tenancy/navigation";
import { listMyWorkspaces, requireWorkspaceContext, WorkspaceAccessError } from "@/lib/tenancy/context";

export const metadata = { robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

async function resolveContext(workspaceSlug: string) {
  try {
    return await requireWorkspaceContext({ workspaceSlug });
  } catch (error) {
    if (error instanceof WorkspaceAccessError && error.code === "UNAUTHENTICATED") redirect(`/login?next=${encodeURIComponent(`/w/${workspaceSlug}`)}`);
    // An unknown slug and a workspace the user cannot open look the same, so a
    // guessed slug reveals nothing about which businesses exist.
    notFound();
  }
}

/**
 * The workspace shell (build sheet §12): the business name is always on
 * screen, navigation shows only modules this workspace has and this user may
 * use, and switching business is a deliberate full navigation.
 */
export default async function WorkspaceLayout({ children, params }: Readonly<{ children: React.ReactNode; params: Promise<{ workspaceSlug: string }> }>) {
  const { workspaceSlug } = await params;
  const context = await resolveContext(workspaceSlug);
  const [workspaces] = await Promise.all([listMyWorkspaces()]);
  const navigation = buildWorkspaceNavigation({
    permissions: context.permissions,
    enabledServices: context.enabled_services,
    legacyOperations: context.legacy_operations ?? false,
  });
  const others = workspaces.filter((workspace) => workspace.slug !== context.workspace.slug);
  const supportView = context.workspace_role === null;

  return (
    <div className="min-h-screen bg-wayne-cream">
      <WorkspaceScope legacyOperations={context.legacy_operations ?? false} locationId={context.location?.id ?? null} workspaceId={context.workspace.id} />
      {supportView && context.support_session ? (
        <SupportBanner expiresAt={context.support_session.expires_at} timeZone={context.workspace.timezone} workspaceName={context.workspace.name} workspaceSlug={context.workspace.slug} />
      ) : supportView ? (
        <p className="bg-wayne-warn-soft px-5 py-2 text-center text-sm font-bold" role="status">
          You are Hanafy platform staff, not a member of {context.workspace.name}, so nothing here is open to you.{" "}
          <Link className="underline" href={`/platform/workspaces/${context.workspace.slug}`}>Start a support session in Platform Admin</Link> to work in this business.
        </p>
      ) : null}
      <header className="border-b border-wayne-border bg-wayne-surface">
        <div className="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center gap-4 px-5 py-3">
          <Link className="grid leading-tight" href={`/w/${context.workspace.slug}`}>
            <span className="font-display text-xl font-black tracking-tight">{context.workspace.name}</span>
            <span className="text-[11px] font-bold uppercase tracking-widest text-wayne-muted">Workspace</span>
          </Link>
          {context.workspace.status === "active" ? null : <Badge tone="warn">{context.workspace.status}</Badge>}
          {others.length ? (
            <details className="relative ml-auto">
              <summary className="cursor-pointer list-none rounded-lg border border-wayne-border px-3 py-2 text-sm font-bold">Switch business ▾</summary>
              <div className="absolute right-0 z-50 mt-2 grid min-w-60 gap-1 rounded-xl border border-wayne-border bg-white p-2 shadow-lg">
                {others.map((workspace) => (
                  // A full page load: the new business starts with no data from this one.
                  <a className="rounded-lg px-3 py-2 text-sm font-bold hover:bg-wayne-cream" href={`/w/${workspace.slug}`} key={workspace.id}>
                    {workspace.name}
                  </a>
                ))}
              </div>
            </details>
          ) : null}
        </div>
        <nav aria-label={`${context.workspace.name} modules`} className="mx-auto max-w-7xl px-5 pb-3">
          <div className="flex flex-wrap items-start gap-x-5 gap-y-2">
            <div className="flex flex-col gap-1">
              <span className="px-1 text-[10px] font-black uppercase tracking-[0.18em] text-wayne-muted">Home</span>
              <Link className="rounded-lg px-2.5 py-1.5 text-sm font-bold hover:bg-wayne-cream-deep" href={`/w/${context.workspace.slug}`}>Overview</Link>
            </div>
            {navigation.map((group) => (
              <div className="flex flex-col gap-1" key={group.name}>
                <span className="px-1 text-[10px] font-black uppercase tracking-[0.18em] text-wayne-muted">{group.name}</span>
                <div className="flex flex-wrap gap-1">
                  {group.items.map((item) => item.external ? (
                    <a className="rounded-lg px-2.5 py-1.5 text-sm font-bold hover:bg-wayne-cream-deep" href={item.href} key={item.href} rel="noopener" target="_blank">{item.label} ↗</a>
                  ) : (
                    <Link className="rounded-lg px-2.5 py-1.5 text-sm font-bold hover:bg-wayne-cream-deep" href={item.href} key={item.href}>{item.label}</Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </nav>
      </header>
      {children}
    </div>
  );
}
