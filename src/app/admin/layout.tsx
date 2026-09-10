import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { signOut } from "./actions";

export const metadata = { robots: { index: false, follow: false } };

export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const access = await requirePermission("admin.access", "/admin");
  const links = [
    hasPermission(access, "menu.manage") && ["/admin/menu", "Menu"],
    hasPermission(access, "orders.view") && ["/admin/orders", "Orders"],
    hasPermission(access, "orders.view") && ["/admin/calendar", "Calendar"],
    hasPermission(access, "reports.view") && ["/admin/reports", "Reports"],
    hasPermission(access, "customers.view") && ["/admin/customers", "Customers"],
    hasPermission(access, "segments.manage") && ["/admin/segments", "Segments"],
    hasPermission(access, "pos.access") && ["/pos", "POS"],
    hasPermission(access, "kitchen.access") && ["/kitchen", "Kitchen"],
    hasPermission(access, "printing.manage") && ["/admin/printing", "Printing"],
    hasPermission(access, "content.manage") && ["/admin/settings", "Website"],
  ].filter((link): link is [string, string] => Boolean(link));

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="border-b border-wayne-border bg-white">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-4 px-5">
          <div className="flex items-center gap-6">
            <Link className="font-black" href="/admin">Wayne&apos;s Pizza</Link>
            <nav aria-label="Admin navigation" className="hidden items-center gap-4 text-sm font-bold md:flex">
              {links.map(([href, label]) => <Link href={href} key={href}>{label}</Link>)}
              <Link href="/" target="_blank">View site ↗</Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-bold">{access.display_name}</p>
              <Badge className="mt-1">{access.role}</Badge>
            </div>
            <form action={signOut}><Button variant="secondary">Sign out</Button></form>
          </div>
        </div>
      </header>
      <nav aria-label="Mobile admin navigation" className="flex gap-4 overflow-x-auto border-b border-wayne-border bg-white px-5 py-3 text-sm font-bold md:hidden">
        <Link href="/admin">Home</Link>
        {links.map(([href, label]) => <Link href={href} key={href}>{label}</Link>)}
      </nav>
      {children}
    </div>
  );
}
