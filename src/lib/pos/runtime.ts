import "server-only";
import { hasService, hasPermission, type CurrentAccess } from "@/lib/auth/permissions";
import { getWorkspaceStoreSettings } from "@/lib/content/queries";
import { getHardwareSettings } from "@/lib/hardware/queries";
import { callerIdProviderSchema } from "@/lib/hardware/schemas";
import { getPosMenu } from "@/lib/pos/queries";
import { getPosKeyedCardConfig, getPosStripeReaderEnabled } from "@/lib/payments/queries";

export async function loadPosRuntime(access: CurrentAccess) {
  const [menu, settings, { settings: hardware }, keyedCardConfig, stripeReaderEnabled] = await Promise.all([getPosMenu(), getWorkspaceStoreSettings(), getHardwareSettings(access), getPosKeyedCardConfig(), getPosStripeReaderEnabled(access)]);
  // CALLER_ID_PROVIDER / CALLER_LINE_COUNT (build sheet §50) override the saved
  // settings for a development or test deployment. Read on the server only.
  const envProvider = callerIdProviderSchema.safeParse(process.env.CALLER_ID_PROVIDER);
  const envLines = Number(process.env.CALLER_LINE_COUNT);
  const effectiveHardware = {
    ...hardware,
    // Payment configuration is the authoritative switch for a live Stripe
    // reader. This keeps the reader visible after a deployment even if an old
    // counter WebView had cached the previous Admin -> Hardware page.
    ...(stripeReaderEnabled ? { payment_terminal_mode: "integrated" as const } : {}),
    ...(envProvider.success ? { caller_id_provider: envProvider.data } : {}),
    ...(Number.isInteger(envLines) && envLines >= 1 && envLines <= 8 ? { caller_line_count: envLines } : {}),
  };
  return { menu, settings, hardware: effectiveHardware, keyedCardConfig,
    callerIdEnabled: hasService(access,"caller_id"), deliveryEnabled: hasService(access,"delivery"),
    workspaceName: settings.store_name || access.workspace_name || "POS",
    canManageDiscount: hasPermission(access,"pos.discount.manage"), canManageHardware: hasPermission(access,"hardware.manage"),
    canCloseOut: hasPermission(access,"cash.manage") || hasPermission(access,"reports.view"), canManageOrders: hasPermission(access,"orders.manage"), canOpenAdmin: hasPermission(access,"admin.access"), profileId:access.profile_id, staffName:access.display_name };
}
export type PosRuntime = Awaited<ReturnType<typeof loadPosRuntime>>;
