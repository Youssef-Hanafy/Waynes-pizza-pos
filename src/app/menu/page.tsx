import type { Metadata } from "next";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { getStoreSettings } from "@/lib/content/queries";
import { isStoreOpenNow } from "@/lib/content/store-status";
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
      <main>
        <section className="bg-wayne-ink px-5 py-12 text-center text-white">
          <p className="text-sm font-black uppercase tracking-[0.2em] text-amber-300">
            {fulfillment} order
          </p>
          <h1 className="mt-3 text-5xl font-black">
            Build your Wayne&apos;s order
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-stone-300">
            {settings.ordering_instructions}
          </p>
          <p className="mx-auto mt-5 max-w-xl rounded-full bg-amber-300 px-5 py-2 text-sm font-black text-wayne-ink">
            TEST / MANUAL MODE — no card payment is collected
          </p>
        </section>
        {menu.length ? (
          <OrderMenuClient
            initialFulfillment={fulfillment}
            menu={menu}
            orderingOpen={orderingOpen}
            pickupEnabled={settings.pickup_enabled}
            deliveryEnabled={settings.delivery_enabled}
            timezone={settings.timezone}
          />
        ) : (
          <div className="mx-auto max-w-2xl px-5 py-24 text-center">
            <h2 className="text-3xl font-black">
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
