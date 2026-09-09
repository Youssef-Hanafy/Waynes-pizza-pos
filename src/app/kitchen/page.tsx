import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { getKitchenBoard } from "@/lib/kitchen/queries";
import type { KitchenTicket } from "@/lib/kitchen/schemas";
import { KitchenBoard } from "./kitchen-board";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Kitchen", robots: { index: false, follow: false } };

export default async function KitchenPage() {
  const access = await requirePermission("kitchen.access", "/kitchen");
  let tickets: KitchenTicket[] = [];
  let initialError = "";
  try { tickets = await getKitchenBoard(); } catch { initialError = "Kitchen is unavailable. Checking connection…"; }
  return <KitchenBoard initialTickets={tickets} initialError={initialError} staffName={access.display_name}
    canOpenAdmin={hasPermission(access, "admin.access")} canOpenPos={hasPermission(access, "pos.access")} />;
}
