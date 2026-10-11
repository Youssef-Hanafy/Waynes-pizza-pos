import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth/access";
import { getWorkspaceStoreSettings } from "@/lib/content/queries";
import { CustomerScreen } from "./customer-screen";

export const metadata: Metadata = { title: "Customer screen", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/** The tablet facing the customer at the counter (owner, 2026-10-11). */
export default async function CustomerScreenPage() {
  const access = await requirePermission("pos.access", "/pos/display");
  const settings = await getWorkspaceStoreSettings();
  return <CustomerScreen storeName={settings.store_name || access.workspace_name || "Welcome"} />;
}
