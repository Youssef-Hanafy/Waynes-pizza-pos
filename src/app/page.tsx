import type { Metadata } from "next";
import Link from "next/link";
import { HoursList } from "@/components/site/hours-list";
import { MenuImage } from "@/components/site/menu-image";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { getStoreSettings } from "@/lib/content/queries";
import { formatAddress } from "@/lib/content/schemas";
import { isStoreOpenNow } from "@/lib/content/store-status";
import { getPublicMenu } from "@/lib/menu/queries";
import { formatCents } from "@/lib/menu/schemas";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getStoreSettings();
  return {
    title: { absolute: settings.seo_home_title },
    description: settings.seo_home_description,
    alternates: { canonical: settings.canonical_url || "/" },
  };
}

export default async function HomePage() {
  const [settings, menu] = await Promise.all([
    getStoreSettings(),
    getPublicMenu(),
  ]);
  const featured = menu
    .flatMap((category) => category.items)
    .filter((item) => item.featured)
    .slice(0, 3);
  const orderingAvailable =
    isStoreOpenNow(settings) &&
    settings.test_ordering_enabled &&
    (settings.pickup_enabled || settings.delivery_enabled);
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Restaurant",
    name: settings.store_name,
    url: settings.canonical_url || undefined,
    telephone: settings.public_phone || undefined,
    servesCuisine: ["Pizza", "Greek", "Italian"],
    address: {
      "@type": "PostalAddress",
      streetAddress: [settings.address_line1, settings.address_line2]
        .filter(Boolean)
        .join(" "),
      addressLocality: settings.city,
      addressRegion: settings.state,
      postalCode: settings.postal_code,
      addressCountry: "US",
    },
  };

  return (
    <div className="min-h-screen bg-wayne-cream">
      <SiteHeader settings={settings} />
      <main>
        <section className="relative overflow-hidden border-b border-wayne-border bg-wayne-ink text-white">
          <div className="absolute inset-0 opacity-20 [background-image:radial-gradient(circle_at_20%_10%,#ef4444,transparent_35%),radial-gradient(circle_at_80%_80%,#f59e0b,transparent_32%)]" />
          <div className="relative mx-auto max-w-7xl px-5 py-14 text-center sm:py-20">
            <p className="text-sm font-black uppercase tracking-[0.25em] text-amber-300">
              {settings.homepage_eyebrow}
            </p>
            <h1 className="mx-auto mt-4 max-w-4xl text-5xl font-black tracking-tight sm:text-7xl">
              {settings.homepage_heading}
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-stone-300">
              {settings.homepage_description}
            </p>
            {!orderingAvailable ? (
              <p className="mx-auto mt-6 max-w-lg rounded-full bg-white/10 px-5 py-3 font-bold">
                Ordering is currently closed. Please check back during regular
                hours.
              </p>
            ) : null}
          </div>
          <div className="relative mx-auto grid max-w-7xl gap-px bg-white/20 sm:grid-cols-2">
            <OrderChoice
              enabled={orderingAvailable && settings.pickup_enabled}
              fulfillment="pickup"
              heading={settings.pickup_heading}
              description={settings.pickup_description}
            />
            <OrderChoice
              enabled={orderingAvailable && settings.delivery_enabled}
              fulfillment="delivery"
              heading={settings.delivery_heading}
              description={settings.delivery_description}
            />
          </div>
        </section>
        {settings.general_notice ? (
          <div className="border-b border-amber-200 bg-amber-50 px-5 py-4 text-center font-semibold">
            {settings.general_notice}
          </div>
        ) : null}
        <section className="mx-auto grid max-w-7xl gap-10 px-5 py-16 lg:grid-cols-2 lg:py-24">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">
              About Wayne&apos;s
            </p>
            <h2 className="mt-3 text-4xl font-black tracking-tight">
              {settings.about_heading}
            </h2>
            <p className="mt-5 text-lg leading-8 text-wayne-muted">
              {settings.story}
            </p>
            <Link
              className="mt-7 inline-flex font-bold text-wayne-red underline-offset-4 hover:underline"
              href="/about"
            >
              Read our story →
            </Link>
          </div>
          <div className="rounded-3xl border border-wayne-border bg-white p-7 shadow-sm">
            <h2 className="text-2xl font-black">{settings.contact_heading}</h2>
            <p className="mt-3 text-wayne-muted">{formatAddress(settings)}</p>
            {settings.public_phone ? (
              <a
                className="mt-2 block text-xl font-black text-wayne-red"
                href={`tel:${settings.public_phone}`}
              >
                {settings.public_phone}
              </a>
            ) : null}
            <div className="mt-6">
              <HoursList settings={settings} />
            </div>
            {settings.service_area_text ? (
              <p className="mt-5 border-t border-wayne-border pt-5 text-sm text-wayne-muted">
                {settings.service_area_text}
              </p>
            ) : null}
          </div>
        </section>
        {featured.length ? (
          <section className="bg-white px-5 py-16">
            <div className="mx-auto max-w-7xl">
              <div className="flex items-end justify-between gap-5">
                <div>
                  <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">
                    Popular picks
                  </p>
                  <h2 className="mt-2 text-4xl font-black">
                    Start with a favorite
                  </h2>
                </div>
                <Link
                  className="hidden font-bold text-wayne-red sm:block"
                  href="/menu"
                >
                  Full menu →
                </Link>
              </div>
              <div className="mt-8 grid gap-6 md:grid-cols-3">
                {featured.map((item) => (
                  <article
                    className="overflow-hidden rounded-2xl border border-wayne-border bg-wayne-cream"
                    key={item.id}
                  >
                    <MenuImage
                      alt={item.image_alt || item.name}
                      path={item.image_path}
                    />
                    <div className="p-5">
                      <div className="flex justify-between gap-4">
                        <h3 className="text-xl font-black">{item.name}</h3>
                        <span className="font-bold text-wayne-red">
                          {item.variants.length
                            ? `From ${formatCents(Math.min(...item.variants.map((variant) => variant.price_cents)))}`
                            : formatCents(item.base_price_cents)}
                        </span>
                      </div>
                      <p className="mt-2 text-sm leading-6 text-wayne-muted">
                        {item.description}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        ) : null}
        <section className="mx-auto max-w-4xl px-5 py-16">
          <p className="text-center text-sm font-black uppercase tracking-[0.2em] text-wayne-red">
            Good to know
          </p>
          <h2 className="mt-2 text-center text-4xl font-black">
            Frequently asked questions
          </h2>
          <div className="mt-8 grid gap-4">
            {settings.faq_items.map((faq) => (
              <details
                className="rounded-2xl border border-wayne-border bg-white p-5"
                key={faq.question}
              >
                <summary className="cursor-pointer font-black">
                  {faq.question}
                </summary>
                <p className="mt-3 leading-7 text-wayne-muted">{faq.answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <SiteFooter settings={settings} />
      <script
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
        }}
        type="application/ld+json"
      />
    </div>
  );
}

function OrderChoice({
  description,
  enabled,
  fulfillment,
  heading,
}: {
  description: string;
  enabled: boolean;
  fulfillment: "pickup" | "delivery";
  heading: string;
}) {
  const content = (
    <>
      <span className="text-sm font-black uppercase tracking-[0.25em] text-amber-300">
        Order now
      </span>
      <span className="mt-2 text-4xl font-black uppercase sm:text-5xl">
        {heading}
      </span>
      <span className="mt-3 max-w-sm text-stone-300">{description}</span>
      <span aria-hidden className="mt-6 text-2xl">
        →
      </span>
    </>
  );
  return enabled ? (
    <Link
      className="flex min-h-64 flex-col items-center justify-center bg-black/20 px-8 py-10 text-center transition hover:bg-wayne-red focus:bg-wayne-red"
      href={`/menu?fulfillment=${fulfillment}`}
    >
      {content}
    </Link>
  ) : (
    <div
      aria-disabled="true"
      className="flex min-h-64 flex-col items-center justify-center bg-black/40 px-8 py-10 text-center opacity-50"
    >
      {content}
    </div>
  );
}
