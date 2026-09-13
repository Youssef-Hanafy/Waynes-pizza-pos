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
    <div className="flex min-h-screen flex-col bg-wayne-cream">
      <SiteHeader settings={settings} />
      <main>
        <section className="relative overflow-hidden bg-wayne-green text-wayne-cream">
          <div className="absolute inset-0 opacity-70 [background-image:radial-gradient(circle_at_18%_-10%,rgba(217,154,33,0.28),transparent_45%),radial-gradient(circle_at_88%_120%,rgba(176,34,34,0.35),transparent_45%)]" />
          <div className="relative mx-auto max-w-7xl px-5 py-16 text-center sm:py-24">
            <p className="text-xs font-black uppercase tracking-[0.3em] text-wayne-gold sm:text-sm">
              {settings.homepage_eyebrow}
            </p>
            <h1 className="mx-auto mt-5 max-w-4xl font-display text-5xl font-black leading-[0.95] tracking-tight sm:text-7xl">
              {settings.homepage_heading}
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-wayne-cream/75">
              {settings.homepage_description}
            </p>
            {!orderingAvailable ? (
              <p className="mx-auto mt-7 max-w-lg rounded-full bg-wayne-cream/10 px-5 py-3 font-bold ring-1 ring-wayne-cream/20">
                Ordering is currently closed. Please check back during regular
                hours.
              </p>
            ) : null}
          </div>
          <div className="relative mx-auto grid max-w-7xl gap-px bg-wayne-cream/15 sm:grid-cols-2">
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
          <div className="border-b border-wayne-warn/30 bg-wayne-warn-soft px-5 py-4 text-center font-semibold">
            {settings.general_notice}
          </div>
        ) : null}
        <section className="mx-auto grid max-w-7xl gap-10 px-5 py-16 lg:grid-cols-2 lg:py-24">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-green">
              About Wayne&apos;s
            </p>
            <h2 className="mt-3 text-4xl font-black tracking-tight">
              {settings.about_heading}
            </h2>
            <p className="mt-5 text-lg leading-8 text-wayne-muted">
              {settings.story}
            </p>
            <Link
              className="mt-7 inline-flex items-center gap-2 font-bold text-wayne-green underline-offset-4 hover:underline"
              href="/about"
            >
              Read our story <span aria-hidden>→</span>
            </Link>
          </div>
          <div className="rounded-3xl border border-wayne-border bg-wayne-surface p-7 shadow-card">
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
          <section className="border-y border-wayne-border bg-wayne-surface px-5 py-16 lg:py-20">
            <div className="mx-auto max-w-7xl">
              <div className="flex items-end justify-between gap-5">
                <div>
                  <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-green">
                    Popular picks
                  </p>
                  <h2 className="mt-2 text-4xl font-black">
                    Start with a favorite
                  </h2>
                </div>
                <Link
                  className="hidden items-center gap-2 font-bold text-wayne-green sm:flex"
                  href="/menu"
                >
                  Full menu <span aria-hidden>→</span>
                </Link>
              </div>
              <div className="mt-8 grid gap-6 md:grid-cols-3">
                {featured.map((item) => (
                  <article
                    className="group overflow-hidden rounded-2xl border border-wayne-border bg-wayne-cream shadow-card transition hover:-translate-y-1 hover:shadow-raised"
                    key={item.id}
                  >
                    <MenuImage
                      alt={item.image_alt || item.name}
                      path={item.image_path}
                    />
                    <div className="p-5">
                      <div className="flex justify-between gap-4">
                        <h3 className="text-xl font-black leading-tight">{item.name}</h3>
                        <span className="shrink-0 font-display font-black text-wayne-red">
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
          <p className="text-center text-sm font-black uppercase tracking-[0.2em] text-wayne-green">
            Good to know
          </p>
          <h2 className="mt-2 text-center text-4xl font-black">
            Frequently asked questions
          </h2>
          <div className="mt-8 grid gap-4">
            {settings.faq_items.map((faq) => (
              <details
                className="group rounded-2xl border border-wayne-border bg-wayne-surface p-5 shadow-card transition open:border-wayne-green/30"
                key={faq.question}
              >
                <summary className="flex cursor-pointer items-center justify-between gap-4 font-display font-black marker:content-['']">
                  {faq.question}
                  <span aria-hidden className="text-wayne-green transition group-open:rotate-45">+</span>
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
      <span className="text-xs font-black uppercase tracking-[0.3em] text-wayne-gold">
        Order now
      </span>
      <span className="mt-3 font-display text-4xl font-black uppercase tracking-tight sm:text-5xl">
        {heading}
      </span>
      <span className="mt-3 max-w-sm text-wayne-cream/70">{description}</span>
      <span aria-hidden className="mt-7 grid h-11 w-11 place-items-center rounded-full bg-wayne-cream/10 text-xl transition group-hover:bg-wayne-red">
        →
      </span>
    </>
  );
  return enabled ? (
    <Link
      className="group flex min-h-64 flex-col items-center justify-center bg-wayne-green-dark/40 px-8 py-12 text-center transition hover:bg-wayne-green-dark focus:bg-wayne-green-dark"
      href={`/menu?fulfillment=${fulfillment}`}
    >
      {content}
    </Link>
  ) : (
    <div
      aria-disabled="true"
      className="group flex min-h-64 flex-col items-center justify-center bg-wayne-green-dark/60 px-8 py-12 text-center opacity-50"
    >
      {content}
    </div>
  );
}
