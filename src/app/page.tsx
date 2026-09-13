import type { Metadata } from "next";
import Link from "next/link";
import { HoursList } from "@/components/site/hours-list";
import { MenuImage } from "@/components/site/menu-image";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { StartOrder } from "@/components/site/start-order";
import { DealCard } from "@/components/site/deal-card";
import { Button } from "@/components/ui/button";
import { getStoreSettings } from "@/lib/content/queries";
import { formatAddress } from "@/lib/content/schemas";
import { isStoreOpenNow } from "@/lib/content/store-status";
import { getPublicMenu } from "@/lib/menu/queries";
import { formatCents } from "@/lib/menu/schemas";
import { getPublicPromotions } from "@/lib/promotions/public";

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
  const [settings, menu, promotions] = await Promise.all([
    getStoreSettings(),
    getPublicMenu(),
    getPublicPromotions(),
  ]);

  const featured = menu.flatMap((category) => category.items).filter((item) => item.featured).slice(0, 4);
  const orderingAvailable =
    isStoreOpenNow(settings) && settings.test_ordering_enabled && (settings.pickup_enabled || settings.delivery_enabled);
  const categories = menu.filter((category) => category.items.length).slice(0, 8);
  const cheapest = (item: (typeof featured)[number]) =>
    item.variants.length ? Math.min(...item.variants.map((variant) => variant.price_cents)) : item.base_price_cents;

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Restaurant",
    name: settings.store_name,
    url: settings.canonical_url || undefined,
    telephone: settings.public_phone || undefined,
    servesCuisine: ["Pizza", "Greek", "Italian"],
    address: {
      "@type": "PostalAddress",
      streetAddress: [settings.address_line1, settings.address_line2].filter(Boolean).join(" "),
      addressLocality: settings.city,
      addressRegion: settings.state,
      postalCode: settings.postal_code,
      addressCountry: "US",
    },
  };

  return (
    <div className="flex min-h-screen flex-col bg-wayne-cream">
      <SiteHeader settings={settings} />

      <main className="pb-20 sm:pb-0">
        {/*
          Everything above the fold is the decision to order. A visitor who came to
          buy pizza should not have to scroll, read a story, or find a nav link — the
          two buttons that start an order are the first thing on the page.
        */}
        <StartOrder
          deliveryEnabled={settings.delivery_enabled}
          orderingAvailable={orderingAvailable}
          phone={settings.public_phone}
          pickupEnabled={settings.pickup_enabled}
        />

        {settings.general_notice ? (
          <div className="border-y border-wayne-warn/40 bg-wayne-warn-soft px-5 py-3 text-center font-semibold">
            {settings.general_notice}
          </div>
        ) : null}

        {promotions.length ? (
          <section className="border-b border-wayne-border bg-wayne-surface px-5 py-12 lg:py-16">
            <div className="mx-auto max-w-7xl">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-green">Deals</p>
                  <h2 className="mt-2 font-display text-3xl font-black tracking-tight sm:text-4xl">
                    Save on tonight&apos;s order
                  </h2>
                </div>
                <p className="text-sm text-wayne-muted">Enter the code at checkout.</p>
              </div>
              <ul className="mt-7 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {promotions.slice(0, 6).map((promotion) => (
                  <li key={promotion.id}>
                    <DealCard promotion={promotion} />
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        {categories.length ? (
          <section className="px-5 py-14 lg:py-20">
            <div className="mx-auto max-w-7xl">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-green">The menu</p>
                  <h2 className="mt-2 font-display text-3xl font-black tracking-tight sm:text-4xl">Pick a category</h2>
                </div>
                <Link className="hidden items-center gap-2 font-bold text-wayne-green sm:flex" href="/menu">
                  See everything <span aria-hidden>→</span>
                </Link>
              </div>
              {/* Straight into the right part of the ordering page, not the top of it. */}
              <ul className="mt-7 grid grid-cols-2 gap-4 md:grid-cols-4">
                {categories.map((category) => (
                  <li key={category.id}>
                    <Link
                      className="group block overflow-hidden rounded-2xl border border-wayne-border bg-wayne-surface shadow-card transition hover:-translate-y-1 hover:border-wayne-green/40 hover:shadow-raised"
                      href={`/menu#category-${category.id}`}
                    >
                      <MenuImage alt={category.image_alt || category.name} path={category.image_path} />
                      <p className="px-4 py-3.5 font-display text-base font-black leading-tight tracking-tight sm:text-lg">
                        {category.name}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        {featured.length ? (
          <section className="border-y border-wayne-border bg-wayne-surface px-5 py-14 lg:py-20">
            <div className="mx-auto max-w-7xl">
              <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-green">Popular picks</p>
              <h2 className="mt-2 font-display text-3xl font-black tracking-tight sm:text-4xl">Start with a favorite</h2>
              <ul className="mt-7 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
                {featured.map((item) => (
                  <li className="flex" key={item.id}>
                    <article className="group flex w-full flex-col overflow-hidden rounded-2xl border border-wayne-border bg-wayne-cream shadow-card transition hover:-translate-y-1 hover:shadow-raised">
                      <MenuImage alt={item.image_alt || item.name} path={item.image_path} />
                      <div className="flex flex-1 flex-col p-5">
                        <h3 className="font-display text-lg font-black leading-tight">{item.name}</h3>
                        {item.description ? (
                          <p className="mt-2 line-clamp-3 text-sm leading-6 text-wayne-muted">{item.description}</p>
                        ) : null}
                        <div className="mt-4 flex items-center justify-between gap-3 pt-1">
                          <span className="font-display text-xl font-black text-wayne-red">
                            {item.variants.length ? `From ${formatCents(cheapest(item))}` : formatCents(cheapest(item))}
                          </span>
                          <Button asChild size="sm">
                            <Link href="/menu">Add</Link>
                          </Button>
                        </div>
                      </div>
                    </article>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        {/* The reason to choose Wayne's over the chain down the road. */}
        <section className="px-5 py-14 lg:py-20">
          <div className="mx-auto grid max-w-7xl gap-10 lg:grid-cols-2">
            <div>
              <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-green">About Wayne&apos;s</p>
              <h2 className="mt-3 font-display text-3xl font-black tracking-tight sm:text-4xl">{settings.about_heading}</h2>
              <p className="mt-5 text-lg leading-8 text-wayne-muted">{settings.story}</p>
              <Link className="mt-7 inline-flex items-center gap-2 font-bold text-wayne-green underline-offset-4 hover:underline" href="/about">
                Read our story <span aria-hidden>→</span>
              </Link>
            </div>
            <div className="rounded-3xl border border-wayne-border bg-wayne-surface p-7 shadow-card">
              <h2 className="font-display text-2xl font-black">{settings.contact_heading}</h2>
              <p className="mt-3 text-wayne-muted">{formatAddress(settings)}</p>
              {settings.public_phone ? (
                <a className="mt-3 block font-display text-3xl font-black tracking-tight text-wayne-red" href={`tel:${settings.public_phone}`}>
                  {settings.public_phone}
                </a>
              ) : null}
              <div className="mt-6">
                <HoursList settings={settings} />
              </div>
              {settings.service_area_text ? (
                <p className="mt-5 border-t border-wayne-border pt-5 text-sm text-wayne-muted">{settings.service_area_text}</p>
              ) : null}
            </div>
          </div>
        </section>

        {settings.faq_items.length ? (
          <section className="mx-auto max-w-4xl px-5 pb-16 lg:pb-24">
            <h2 className="text-center font-display text-3xl font-black tracking-tight sm:text-4xl">
              Frequently asked questions
            </h2>
            <div className="mt-8 grid gap-4">
              {settings.faq_items.map((faq) => (
                <details className="group rounded-2xl border border-wayne-border bg-wayne-surface p-5 shadow-card transition open:border-wayne-green/30" key={faq.question}>
                  <summary className="flex cursor-pointer items-center justify-between gap-4 font-display font-black marker:content-['']">
                    {faq.question}
                    <span aria-hidden className="text-wayne-green transition group-open:rotate-45">+</span>
                  </summary>
                  <p className="mt-3 leading-7 text-wayne-muted">{faq.answer}</p>
                </details>
              ))}
            </div>
          </section>
        ) : null}
      </main>

      {/* On a phone the order button follows you down the page. */}
      {orderingAvailable ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-wayne-border bg-wayne-cream/95 p-3 backdrop-blur-md sm:hidden">
          <Button asChild className="w-full" size="lg">
            <Link href="/menu">Start your order</Link>
          </Button>
        </div>
      ) : null}

      <SiteFooter settings={settings} />
      <script
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }}
        type="application/ld+json"
      />
    </div>
  );
}
