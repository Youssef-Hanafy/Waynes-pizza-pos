import { describe, expect, it } from "vitest";
import { defaultSettings } from "@/lib/content/schemas";
import { defaultHardwareSettings } from "@/lib/hardware/schemas";
import { posRuntimeSchema } from "./runtime-schema";

const runtime = {
  menu: [], settings: defaultSettings, hardware: defaultHardwareSettings,
  keyedCardConfig: null, callerIdEnabled: true, deliveryEnabled: true,
  workspaceName: "Wayne's Pizza", canManageDiscount: true,
  canManageHardware: true, canCloseOut: true, canManageOrders: true,
  canOpenAdmin: true, profileId: "cashier", staffName: "Cashier",
};

describe("runtime refresh validation", () => {
  it("accepts the server's complete runtime including Stripe configuration", () => {
    expect(posRuntimeSchema.parse(runtime)).toMatchObject(runtime);
    const stripe = { ...runtime, keyedCardConfig: { provider: "stripe", publishable_key: "pk_test_fixture", online_card_enabled: true } };
    expect(posRuntimeSchema.parse(stripe)).toMatchObject(stripe);
  });
  it.each([undefined, null, {}, { ...runtime, settings: null }, { ...runtime, menu: [{}] }, { ...runtime, hardware: null }, { ...runtime, canManageOrders: undefined }])("rejects incomplete or malformed runtime: %j", data => {
    expect(posRuntimeSchema.safeParse(data).success).toBe(false);
  });
});
