import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { AdminNav } from "./admin-nav";
import { signOut } from "./actions";

export const metadata = { robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const access = await requirePermission("admin.access", "/admin");

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
        hasPermission(access, "integrations.manage") && ["/admin/integrations", "Integration"],
        hasPermission(access, "staff.view") && ["/admin/staff", "Staff"],
        hasPermission(access, "audit.view") && ["/admin/audit", "Audit"],
      ],
    },
  ]
    .map((group) => ({ ...group, links: group.links.filter((link): link is [string, string] => Boolean(link)) }))
    .filter((group) => group.links.length);

  return (
    <div className="flex min-h-screen flex-col bg-wayne-cream">
      <header className="sticky top-0 z-40 border-b border-wayne-border bg-wayne-surface/95 backdrop-blur-md">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center gap-5 px-5">
          <Link className="flex items-center gap-2.5" href="/admin">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-wayne-green font-display text-sm font-black text-wayne-cream">W</span>
            <span className="grid leading-tight">
              <span className="font-display text-base font-black tracking-tight">Wayne&apos;s Pizza</span>
              <span className="text-[11px] font-bold uppercase tracking-widest text-wayne-muted">Back of house</span>
            </span>
          </Link>

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
