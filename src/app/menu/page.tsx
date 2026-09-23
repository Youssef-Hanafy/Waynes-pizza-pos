import type { Metadata } from "next";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { getStoreSettings } from "@/lib/content/queries";
import { isOnlineOrderingAvailable } from "@/lib/payments/queries";
import { getPublicMenu } from "@/lib/menu/queries";
import { OrderMenuClient } from "./order-menu-client";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getStoreSettings();
  return {
    title: settings.seo_menu_title,
    description: settings.seo_menu_description,
    alternates: {
      canonical: settings.canonical_url
        ? `${settings.canonical_url}/menu`
        : "/menu",
    },
  };
}

export default async function MenuPage({
  searchParams,
}: {
  searchParams: Promise<{ fulfillment?: string; item?: string }>;
}) {
  const [settings, menu, params] = await Promise.all([
    getStoreSettings(),
    getPublicMenu(),
    searchParams,
  ]);
  const fulfillment = params.fulfillment === "delivery" ? "delivery" : "pickup";
  const orderingOpen = await isOnlineOrderingAvailable(settings);
  return (
    <div className="storefront flex min-h-screen flex-col">
      <SiteHeader settings={settings} />
      <main id="main-content">
        <section className="menu-intro">
          <div className="site-container">
            <div>
              <p className="eyebrow">FRESH FROM WAYNE’S</p>
              <h1>Good food. Great choices.</h1>
              <p>
                Pick your favorites. Make them yours. We’ll take it from here.
              </p>
            </div>
            <div className="menu-intro-note">
              <span>YOUR NEXT GREAT MEAL</span>
              <strong>starts right here.</strong>
            </div>
          </div>
        </section>
        {menu.length ? (
          <OrderMenuClient
            initialFulfillment={fulfillment}
            initialItemId={params.item}
            pickupMinutes={settings.pickup_prep_minutes}
            deliveryMinutes={settings.delivery_estimate_minutes}
            menu={menu}
            orderingOpen={orderingOpen}
            pickupEnabled={settings.pickup_enabled}
            deliveryEnabled={settings.delivery_enabled}
            timezone={settings.timezone}
          />
        ) : (
          <div className="mx-auto max-w-2xl px-5 py-24 text-center">
            <h2 className="font-display text-3xl font-black">
              The online menu is being prepared.
            </h2>
            <p className="mt-3 text-wayne-muted">
              Please call {settings.public_phone || "Wayne's Pizza"} for current
              selections.
            </p>
          </div>
        )}
      </main>
      <SiteFooter settings={settings} />
    </div>
  );
}
