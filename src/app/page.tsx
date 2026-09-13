import type { Metadata } from "next";
import Link from "next/link";
import { RewardsSection } from "@/components/site/rewards-section";
import { SiteIcon } from "@/components/site/site-icon";
import { HoursList } from "@/components/site/hours-list";
import { MenuImage } from "@/components/site/menu-image";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { StartOrder } from "@/components/site/start-order";
import { DealCard } from "@/components/site/deal-card";
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

  const allItems = menu.flatMap((category) =>
    category.items.map((item) => ({ ...item, categoryName: category.name })),
  );
  const curated = [
    "Cheese Pizza",
    "Meat Lovers",
    "Veggie Combo",
    "Buffalo Chicken Pizza",
  ];
  const featured = [
    ...allItems.filter((item) => item.featured),
    ...curated.flatMap((name) => allItems.filter((item) => item.name === name)),
  ]
    .filter(
      (item, index, list) =>
        list.findIndex((other) => other.id === item.id) === index,
    )
    .slice(0, 4);
  const orderingAvailable =
    isStoreOpenNow(settings) &&
    settings.test_ordering_enabled &&
    (settings.pickup_enabled || settings.delivery_enabled);
  const categories = [
    "Pizza",
    "Gourmet Pizza",
    "Calzones",
    "Appetizers",
    "Salads",
    "Cold Subs",
  ].flatMap((name) =>
    menu.filter((category) => category.name === name && category.items.length),
  );
  const cheapest = (item: (typeof featured)[number]) =>
    item.variants.length
      ? Math.min(...item.variants.map((variant) => variant.price_cents))
      : item.base_price_cents;

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
    <div className="storefront">
      <SiteHeader settings={settings} />
      <main id="main-content">
        <StartOrder
          deliveryEnabled={settings.delivery_enabled}
          orderingAvailable={orderingAvailable}
          phone={settings.public_phone}
          pickupEnabled={settings.pickup_enabled}
          pickupMinutes={settings.pickup_prep_minutes}
          deliveryMinutes={settings.delivery_estimate_minutes}
        />
        {settings.general_notice && (
          <div className="site-notice">{settings.general_notice}</div>
        )}
        <section className="site-container category-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">A LITTLE SOMETHING FOR EVERY CRAVING</p>
              <h2>What sounds good?</h2>
            </div>
            <Link className="text-link" href="/menu">
              Explore the full menu <SiteIcon name="arrow" size={18} />
            </Link>
          </div>
          <div className="category-grid">
            {categories.map((category) => (
              <Link
                className="category-tile group"
                href={`/menu#category-${category.id}`}
                key={category.id}
              >
                <MenuImage
                  alt={category.image_alt || category.name}
                  name={category.name}
                  path={category.image_path}
                  sizes="(max-width: 640px) 40vw, 180px"
                />
                <span>
                  {category.name === "Cold Subs"
                    ? "Subs & sandwiches"
                    : category.name}
                  <SiteIcon name="arrow" size={16} />
                </span>
              </Link>
            ))}
          </div>
        </section>
        <section id="favorites" className="favorites-section">
          <div className="site-container">
            <div className="section-heading">
              <div>
                <p className="eyebrow">THE HARDEST PART? PICKING JUST ONE.</p>
                <h2>Find your next favorite.</h2>
              </div>
              <Link href="/menu" className="text-link">
                All the good stuff <SiteIcon name="arrow" size={18} />
              </Link>
            </div>
            <div className="favorites-grid">
              {featured.map((item, index) => (
                <article className="favorite-card group" key={item.id}>
                  <div className="favorite-photo">
                    <MenuImage
                      alt={item.image_alt || item.name}
                      name={item.name}
                      category={item.categoryName}
                      path={item.image_path}
                      sizes="(max-width: 600px) 90vw, (max-width: 1000px) 45vw, 300px"
                    />
                    <span className="food-tag">
                      {
                        [
                          "THE CLASSIC",
                          "BIG ON FLAVOR",
                          "GARDEN GOODNESS",
                          "TURN UP THE HEAT",
                        ][index]
                      }
                    </span>
                  </div>
                  <div className="favorite-content">
                    <h3>{item.name}</h3>
                    <p>
                      {item.description ||
                        "A pizza-night essential, made fresh and ready for your favorite toppings."}
                    </p>
                    <div className="favorite-bottom">
                      <div>
                        <small>
                          {item.variants.length ? "STARTING AT" : "PRICE"}
                        </small>
                        <strong>{formatCents(cheapest(item))}</strong>
                      </div>
                      <Link
                        className="add-button"
                        href={`/menu?item=${item.id}`}
                        aria-label={`Customize ${item.name}`}
                      >
                        Make it yours <SiteIcon name="plus" size={17} />
                      </Link>
                    </div>
                  </div>
                </article>
              ))}
            </div>

          </div>
        </section>
        <div id="deals"><RewardsSection /></div>
        {promotions.length > 0 && (
          <section id="current-deals" className="site-container deals-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">MORE TO LOVE</p>
                <h2>A good night. A great deal.</h2>
              </div>
              <span>Enter your code at checkout.</span>
            </div>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {promotions.slice(0, 6).map((promotion) => (
                <DealCard key={promotion.id} promotion={promotion} />
              ))}
            </div>
          </section>
        )}
        <section className="site-container more-section">
          <div className="more-card">
            <div>
              <p className="eyebrow light">MAKE IT A MEAL</p>
              <h2>
                Pizza’s got
                <br />
                great company.
              </h2>
              <p>
                Crispy sides. Stacked subs. Fresh salads.
                <br />
                Something for everyone at the table.
              </p>
              <Link
                href={`/menu#category-${menu.find((category) => category.name === "Appetizers")?.id || ""}`}
                className="order-button"
              >
                Meet the whole menu <SiteIcon name="arrow" size={18} />
              </Link>
            </div>

          </div>
        </section>
        <section className="story-section">
          <div className="site-container story-grid">
            <div className="story-art">
              <span className="eyebrow">WORCESTER, MASSACHUSETTS</span>
              <SiteIcon name="pizza" size={90} />
              <strong>
                50<span>+</span>
              </strong>
              <span className="story-years">YEARS OF LOCAL LOVE</span>
              <div className="story-art-bottom">GOOD FOOD. GREAT PEOPLE.</div>
            </div>
            <div className="story-copy">
              <p className="eyebrow">MORE THAN A PIZZA PLACE</p>
              <h2>
                A neighborhood original.
                <br />
                <em>Always Wayne’s.</em>
              </h2>
              <p>{settings.story}</p>
              <Link href="/about" className="text-link">
                Get to know Wayne’s <SiteIcon name="arrow" size={18} />
              </Link>
              <div className="story-details">
                <span>
                  <SiteIcon name="pin" />
                  {settings.address_line1}, {settings.city}
                </span>
                <a href={`tel:${settings.public_phone}`}>
                  <SiteIcon name="phone" />
                  {settings.public_phone}
                </a>
              </div>
            </div>
          </div>
        </section>
        <section className="site-container visit-section">
          <div>
            <p className="eyebrow">SAVE US A SPOT AT YOUR TABLE</p>
            <h2>Tonight’s looking delicious.</h2>
            <p>Pickup on your way home, or pizza at your door. You choose.</p>
            <Link href="/menu" className="order-button">
              Start your order <SiteIcon name="arrow" />
            </Link>
          </div>
          <div className="visit-hours">
            <h3>Come on over.</h3>
            <p>{formatAddress(settings)}</p>
            <HoursList settings={settings} />
            <Link href="/contact" className="text-link">
              Hours & location <SiteIcon name="arrow" size={16} />
            </Link>
          </div>
        </section>
        {settings.faq_items.length > 0 && (
          <section className="site-container faq-section">
            <p className="eyebrow">GOOD TO KNOW</p>
            <h2>A few quick answers.</h2>
            {settings.faq_items.map((faq) => (
              <details key={faq.question}>
                <summary>
                  {faq.question}
                  <SiteIcon name="plus" size={19} />
                </summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </section>
        )}
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
