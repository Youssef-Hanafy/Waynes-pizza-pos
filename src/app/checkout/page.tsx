import Link from "next/link";
import { SiteIcon } from "@/components/site/site-icon";
import type { Metadata } from "next";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { getStoreSettings } from "@/lib/content/queries";
import { isStoreOpenNow } from "@/lib/content/store-status";
import { getPublicMenu } from "@/lib/menu/queries";
import { getCheckoutPaymentConfig } from "@/lib/payments/queries";
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
  const [settings, menu, paymentConfig, params] = await Promise.all([
    getStoreSettings(),
    getPublicMenu(),
    getCheckoutPaymentConfig(),
    searchParams,
  ]);
  const fulfillment = params.fulfillment === "delivery" ? "delivery" : "pickup";
  // Open when the store is open and a card can be taken or TEST ordering is on.
  const orderingOpen =
    isStoreOpenNow(settings) && (settings.test_ordering_enabled || paymentConfig !== null);
  return (
    <div className="storefront checkout-page min-h-screen">
      <SiteHeader settings={settings} />
      <main id="main-content" className="mx-auto max-w-6xl px-5 py-10">
        <nav className="checkout-steps" aria-label="Order progress">
          <Link href={`/menu?fulfillment=${fulfillment}`}>
            <SiteIcon name="check" size={14} />
            Your favorites
          </Link>
          <span>—</span>
          <strong>2. Checkout</strong>
          <span>—</span>
          <span>3. Enjoy</span>
        </nav>
        <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">
          Checkout
        </p>
        <h1 className="mt-3 text-4xl font-black">
          {paymentConfig
            ? "Review and pay for your order"
            : "Review and place your test order"}
        </h1>
        <p className="mt-3 max-w-2xl text-wayne-muted">
          {paymentConfig
            ? "Your card is charged when you place the order. Wayne's starts cooking once the payment clears."
            : "This checkout is clearly labeled TEST / MANUAL. It saves a real test order but does not collect card payment."}
        </p>
        <CheckoutClient
          fulfillment={fulfillment}
          menu={menu}
          paymentConfig={paymentConfig}
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
