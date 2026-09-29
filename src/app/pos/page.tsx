import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth/access";
import { hasPermission, hasService } from "@/lib/auth/permissions";
import { getWorkspaceStoreSettings } from "@/lib/content/queries";
import { getHardwareSettings } from "@/lib/hardware/queries";
import { callerIdProviderSchema } from "@/lib/hardware/schemas";
import { getPosMenu } from "@/lib/pos/queries";
import { AutoRefresh } from "@/components/ops/auto-refresh";
import { SupportPill } from "@/components/ops/support-banner";
import { WorkspaceScope } from "@/components/ops/workspace-scope";
import { PosApp } from "./pos-app";

export const metadata: Metadata = { title: "Front POS", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function PosPage() {
  const access = await requirePermission("pos.access", "/pos");
  const [menu, settings, { settings: hardware }] = await Promise.all([getPosMenu(), getWorkspaceStoreSettings(), getHardwareSettings()]);
  // CALLER_ID_PROVIDER / CALLER_LINE_COUNT (build sheet §50) override the saved
  // settings for a development or test deployment. Read on the server only.
  const envProvider = callerIdProviderSchema.safeParse(process.env.CALLER_ID_PROVIDER);
  const envLines = Number(process.env.CALLER_LINE_COUNT);
  const effectiveHardware = {
    ...hardware,
    ...(envProvider.success ? { caller_id_provider: envProvider.data } : {}),
    ...(Number.isInteger(envLines) && envLines >= 1 && envLines <= 8 ? { caller_line_count: envLines } : {}),
  };
  // The menu (sold-out items, prices) refreshes in the background; open tickets live in the draft store and are kept.
  return <>
    <WorkspaceScope defaultCity={settings.city} defaultState={settings.state} legacyOperations={access.legacy_operations ?? false} locationId={access.location_id ?? null} workspaceId={access.workspace_id ?? null} />
    <PosApp
      callerIdEnabled={hasService(access, "caller_id")}
      deliveryEnabled={hasService(access, "delivery")}
      workspaceName={settings.store_name || access.workspace_name || "POS"}
      canManageDiscount={hasPermission(access, "pos.discount.manage")}
      canManageHardware={hasPermission(access, "hardware.manage")}
      canManageOrders={hasPermission(access, "orders.manage")}
      canOpenAdmin={hasPermission(access, "admin.access")}
      hardware={effectiveHardware}
      menu={menu}
      profileId={access.profile_id}
      settings={settings}
      staffName={access.display_name}
    />
    <SupportPill access={access} />
    <div className="sr-only"><AutoRefresh intervalMs={60_000} label="Menu refreshes every minute" /></div>
  </>;
}
