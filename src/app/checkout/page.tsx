import type { Metadata } from "next";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { getStoreSettings } from "@/lib/content/queries";
import { isStoreOpenNow } from "@/lib/content/store-status";
import { getPublicMenu } from "@/lib/menu/queries";
import { CheckoutClient } from "./checkout-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Checkout",
  robots: { index: false, follow: false },
};

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ fulfillment?: string }>;
}) {
  const [settings, menu, params] = await Promise.all([
    getStoreSettings(),
    getPublicMenu(),
    searchParams,
  ]);
  const fulfillment = params.fulfillment === "delivery" ? "delivery" : "pickup";
  const orderingOpen =
    isStoreOpenNow(settings) && settings.test_ordering_enabled;
  return (
    <div className="min-h-screen">
      <SiteHeader settings={settings} />
      <main className="mx-auto max-w-6xl px-5 py-10">
        <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">
          Checkout
        </p>
        <h1 className="mt-3 text-4xl font-black">
          Review and place your test order
        </h1>
        <p className="mt-3 max-w-2xl text-wayne-muted">
          This Phase 2 checkout is clearly labeled TEST / MANUAL. It saves a
          real test order but does not collect card payment.
        </p>
        <CheckoutClient
          fulfillment={fulfillment}
          menu={menu}
          settings={{
            delivery_enabled: settings.delivery_enabled,
            delivery_fee_cents: settings.delivery_fee_cents,
            delivery_minimum_cents: settings.delivery_minimum_cents,
            pickup_enabled: settings.pickup_enabled,
            pickup_minimum_cents: settings.pickup_minimum_cents,
            suggested_tip_percentages: settings.suggested_tip_percentages,
            tax_rate_basis_points: settings.tax_rate_basis_points,
            test_ordering_enabled: orderingOpen,
            tips_enabled: settings.tips_enabled,
          }}
        />
      </main>
      <SiteFooter settings={settings} />
    </div>
  );
}
