import type { Metadata } from "next";
import { requirePermission } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { getStoreSettings } from "@/lib/content/queries";
import { getHardwareSettings } from "@/lib/hardware/queries";
import { callerIdProviderSchema } from "@/lib/hardware/schemas";
import { getPosMenu } from "@/lib/pos/queries";
import { AutoRefresh } from "@/components/ops/auto-refresh";
import { PosApp } from "./pos-app";

export const metadata: Metadata = { title: "Front POS", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function PosPage() {
  const access = await requirePermission("pos.access", "/pos");
  const [menu, settings, { settings: hardware }] = await Promise.all([getPosMenu(), getStoreSettings(), getHardwareSettings()]);
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
    <PosApp
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
    <div className="sr-only"><AutoRefresh intervalMs={60_000} label="Menu refreshes every minute" /></div>
  </>;
}
