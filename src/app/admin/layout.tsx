import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { isPathEnabled } from "@/lib/tenancy/services";
import { WorkspaceScope } from "@/components/ops/workspace-scope";
import { AdminNav } from "./admin-nav";
import { signOut } from "./actions";

export const metadata = { robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const access = await requirePermission("admin.access", "/admin");
  const workspaceName = access.workspace_name ?? "Workspace";

  /*
   * Grouped the way a manager thinks about the evening: what is happening right
   * now, then the money, then the things you set up once and rarely touch. The
   * flat alphabet-soup row this replaced made Cash and Audit look equally urgent.
   */
  const groups = [
    {
      name: "Service",
      links: [
        hasPermission(access, "orders.view") && ["/admin/orders", "Orders"],
        hasPermission(access, "pos.access") && ["/pos", "POS"],
        hasPermission(access, "kitchen.access") && ["/kitchen", "Kitchen"],
        (hasPermission(access, "delivery.dispatch") || hasPermission(access, "reports.view")) && ["/admin/delivery", "Delivery"],
        hasPermission(access, "orders.view") && ["/admin/calendar", "Calendar"],
      ],
    },
    {
      name: "Money",
      links: [
        hasPermission(access, "reports.view") && ["/admin/reports", "Reports"],
        hasPermission(access, "cash.manage") && ["/admin/cash", "Cash"],
        hasPermission(access, "payments.manage") && ["/admin/payments", "Payments"],
      ],
    },
    {
      name: "Customers",
      links: [
        hasPermission(access, "customers.view") && ["/admin/customers", "Customers"],
        hasPermission(access, "segments.manage") && ["/admin/segments", "Segments"],
        hasPermission(access, "promotions.manage") && ["/admin/promotions", "Promotions"],
      ],
    },
    {
      name: "Setup",
      links: [
        hasPermission(access, "menu.manage") && ["/admin/menu", "Menu"],
        hasPermission(access, "content.manage") && ["/admin/settings", "Website"],
        hasPermission(access, "printing.manage") && ["/admin/printing", "Printing"],
        hasPermission(access, "hardware.manage") && ["/admin/hardware", "Hardware"],
        hasPermission(access, "pilot.manage") && ["/admin/pilot", "Pilot"],
        hasPermission(access, "integrations.manage") && ["/admin/integrations", "Integration"],
        hasPermission(access, "staff.view") && ["/admin/staff", "Staff"],
        hasPermission(access, "audit.view") && ["/admin/audit", "Audit"],
      ],
    },
  ]
    // Module-aware: a section whose service is off for this workspace is not
    // shown (the database has already withdrawn its permissions as well).
    .map((group) => ({ ...group, links: group.links.filter((link): link is [string, string] => Boolean(link) && isPathEnabled((link as [string, string])[0], access.enabled_services ?? [])) }))
    .filter((group) => group.links.length);

  return (
    <div className="flex min-h-screen flex-col bg-wayne-cream">
      <WorkspaceScope legacyOperations={access.legacy_operations ?? false} locationId={access.location_id ?? null} workspaceId={access.workspace_id ?? null} />
      <header className="sticky top-0 z-40 border-b border-wayne-border bg-wayne-surface/95 backdrop-blur-md">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center gap-5 px-5">
          <Link className="flex items-center gap-2.5" href="/admin">
            <span aria-hidden className="grid h-9 w-9 place-items-center rounded-lg bg-wayne-green font-display text-sm font-black text-wayne-cream">{workspaceName.trim().charAt(0).toUpperCase() || "H"}</span>
            <span className="grid leading-tight">
              <span className="font-display text-base font-black tracking-tight">{workspaceName}</span>
              <span className="text-[11px] font-bold uppercase tracking-widest text-wayne-muted">Back of house</span>
            </span>
          </Link>
          {access.workspace_slug ? (
            <Link className="hidden rounded-lg px-2.5 py-1.5 text-sm font-bold text-wayne-muted transition hover:bg-wayne-cream-deep hover:text-wayne-green md:inline" href={(access.membership_count ?? 1) > 1 ? "/w" : `/w/${access.workspace_slug}`}>
              {(access.membership_count ?? 1) > 1 ? "Switch business" : "Workspace"}
            </Link>
          ) : null}

          <div className="ml-auto flex items-center gap-3">
            <Link className="hidden text-sm font-bold text-wayne-muted transition hover:text-wayne-green sm:inline" href="/" target="_blank">
              View site ↗
            </Link>
            <div className="hidden text-right sm:block">
              <p className="text-sm font-bold leading-tight">{access.display_name}</p>
              <Badge className="mt-0.5" tone="neutral">{access.role}</Badge>
            </div>
            <form action={signOut}><Button size="sm" variant="secondary">Sign out</Button></form>
          </div>
        </div>
        <AdminNav groups={groups} />
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}
