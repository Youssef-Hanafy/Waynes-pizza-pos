import { z } from "zod";
import { storeSettingsSchema } from "@/lib/content/schemas";
import { hardwareSettingsSchema } from "@/lib/hardware/schemas";
import { publicMenuSchema } from "@/lib/menu/schemas";
import { checkoutPaymentConfigSchema } from "@/lib/payments/schemas";

/** Validate network data before replacing the working register's runtime. */
export const posRuntimeSchema = z.object({
  menu: publicMenuSchema,
  settings: storeSettingsSchema,
  hardware: hardwareSettingsSchema,
  keyedCardConfig: z.union([checkoutPaymentConfigSchema.options[1], checkoutPaymentConfigSchema.options[2]]).nullable(),
  callerIdEnabled: z.boolean(),
  deliveryEnabled: z.boolean(),
  workspaceName: z.string(),
  canManageDiscount: z.boolean(),
  canManageHardware: z.boolean(),
  canCloseOut: z.boolean(),
  canManageOrders: z.boolean(),
  canOpenAdmin: z.boolean(),
  profileId: z.string(),
  staffName: z.string(),
});
