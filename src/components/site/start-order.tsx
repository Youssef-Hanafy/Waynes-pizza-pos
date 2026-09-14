import Image from "next/image";
import Link from "next/link";
import { getPublicAssetUrl } from "@/lib/images/public-url";
import { SiteIcon } from "./site-icon";

export function StartOrder({
  deliveryEnabled,
  heroImageAlt = "",
  heroImagePath = null,
  orderingAvailable,
  phone,
  pickupEnabled,
  pickupMinutes = 25,
  deliveryMinutes = 45,
}: {
  deliveryEnabled: boolean;
  /* Whatever photo the owner put on the first menu category carries the hero,
     so the front page updates from Admin -> Menu photos like everything else. */
  heroImageAlt?: string;
  heroImagePath?: string | null;
  orderingAvailable: boolean;
  phone: string;
  pickupEnabled: boolean;
  pickupMinutes?: number;
  deliveryMinutes?: number;
}) {
  const heroImageUrl = getPublicAssetUrl(heroImagePath);
  const choices = [
    {
      enabled: pickupEnabled,
      fulfillment: "pickup",
      label: "Pickup",
      note: `Approx. ${pickupMinutes} min`,
      icon: "bag" as const,
    },
    {
      enabled: deliveryEnabled,
      fulfillment: "delivery",
      label: "Delivery",
      note: `Approx. ${deliveryMinutes} min`,
      icon: "truck" as const,
    },
  ].filter((choice) => choice.enabled);
  return (
    <>
      <section className="pizza-hero">
        {heroImageUrl ? (
          <>
            <div className="hero-photograph">
              <Image
                alt={heroImageAlt}
                className="object-cover"
                fill
                priority
                sizes="100vw"
                src={heroImageUrl}
              />
            </div>
            <div className="hero-shade" />
          </>
        ) : null}
        <div className="site-container hero-content">
          <div className="hero-copy">
            <p className="eyebrow light">
              <span /> YOUR NEIGHBORHOOD. YOUR PIZZA.
            </p>
            <h1>
              Make tonight
              <br />
              a <span>Wayne’s night.</span>
            </h1>
            <p className="hero-description">
              The crispy crust. The melty cheese. The first bite.
              <br className="desktop-break" /> Your Wayne&apos;s favorites,
              fresh from our oven.
            </p>
            <div className="hero-actions">
              <Link className="order-button" href="/menu?fulfillment=pickup">
                Order carryout <SiteIcon name="arrow" />
              </Link>
              <Link className="hero-secondary" href="/menu?fulfillment=delivery">
                Get delivery <SiteIcon name="arrow" />
              </Link>
            </div>
            <div className="hero-proof">
              <span className="hero-stars" aria-hidden>
                ✦ ✦ ✦
              </span>{" "}
              Over 50 years of bringing people to the table.
            </div>
          </div>
          <div className="hero-stamp" aria-hidden>
            <span>WORCESTER, MA</span>
            <strong>
              Wayne’s<br />PIZZA
            </strong>
            <span>★ THE GOOD STUFF ★</span>
          </div>
          <div className="hero-caption">
            <span className="status-dot is-open" /> GOOD NIGHTS START WITH
            PIZZA.
          </div>
        </div>
      </section>
      <div className="site-container order-start-wrap">
        <section className="order-start" aria-label="Start your order">
          <div className="order-start-title">
            <span className="order-start-icon">
              <SiteIcon name="pizza" size={30} />
            </span>
            <div>
              <p className="eyebrow">LET’S EAT</p>
              <h2>
                {orderingAvailable
                  ? "How do you want your Wayne’s?"
                  : "A little menu inspiration?"}
              </h2>
              <p>
                {orderingAvailable
                  ? "Your favorites are just a few clicks away."
                  : "Online ordering is closed. Explore the menu for your next visit."}
              </p>
            </div>
          </div>
          <div className="order-choices">
            {orderingAvailable && choices.length ? (
              choices.map((choice) => (
                <Link
                  className={`fulfillment-card ${choice.fulfillment}`}
                  href={`/menu?fulfillment=${choice.fulfillment}`}
                  key={choice.fulfillment}
                >
                  <SiteIcon name={choice.icon} size={26} />
                  <span>
                    <strong>{choice.label}</strong>
                    <small>{choice.note}</small>
                  </span>
                  <SiteIcon name="arrow" size={21} />
                </Link>
              ))
            ) : (
              <>
                <Link className="order-button" href="/menu">
                  Browse the menu <SiteIcon name="arrow" />
                </Link>
                {phone && (
                  <a className="text-link" href={`tel:${phone}`}>
                    Call {phone}
                  </a>
                )}
              </>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
