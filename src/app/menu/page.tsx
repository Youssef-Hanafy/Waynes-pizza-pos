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
    <div className="flex min-h-screen flex-col">
      <SiteHeader settings={settings} />
      <main>
        <section className="relative overflow-hidden bg-wayne-green px-5 py-14 text-center text-wayne-cream">
          <div className="absolute inset-0 opacity-70 [background-image:radial-gradient(circle_at_15%_-20%,rgba(217,154,33,0.25),transparent_45%),radial-gradient(circle_at_85%_130%,rgba(176,34,34,0.3),transparent_45%)]" />
          <div className="relative">
            <p className="text-xs font-black uppercase tracking-[0.3em] text-wayne-gold sm:text-sm">
              {fulfillment} order
            </p>
            <h1 className="mt-4 font-display text-4xl font-black tracking-tight sm:text-5xl">
              Build your Wayne&apos;s order
            </h1>
            <p className="mx-auto mt-4 max-w-2xl leading-7 text-wayne-cream/75">
              {settings.ordering_instructions}
            </p>
            <p className="mx-auto mt-6 inline-flex max-w-xl items-center gap-2 rounded-full bg-wayne-gold px-5 py-2 text-sm font-black text-wayne-ink">
              <span aria-hidden className="h-2 w-2 rounded-full bg-wayne-ink/60" />
              TEST / MANUAL MODE — no card payment is collected
            </p>
          </div>
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
