import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { getStoreSettings } from "@/lib/content/queries";
import { getPosMenu } from "@/lib/pos/queries";
import { PosClient } from "./pos-client";

export const metadata: Metadata = { title: "Front POS", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function PosPage() {
  const access = await requirePermission("pos.access", "/pos");
  const [menu, settings] = await Promise.all([getPosMenu(), getStoreSettings()]);
  return <PosClient canManageDiscount={hasPermission(access, "pos.discount.manage")} canOpenAdmin={hasPermission(access, "admin.access")} menu={menu} settings={settings} staffName={access.display_name} />;
}
