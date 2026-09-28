import Link from "next/link";
import { formatAddress, type StoreSettings } from "@/lib/content/schemas";
import { BrandMark } from "./brand-mark";
import { SiteIcon } from "./site-icon";
import { SocialLinks } from "./social-links";
export function SiteFooter({ settings }: { settings: StoreSettings }) {
  return (
    <footer className="site-footer">
      <div className="checker-strip" aria-hidden />
      <div className="site-container footer-grid">
        <div>
          <Link href="/" className="footer-brand">
            <BrandMark name={settings.store_name} city={[settings.city, settings.state].filter(Boolean).join(", ")} />
          </Link>
          <p>
            {settings.story}
          </p>
        </div>
        <nav aria-label="Footer navigation">
          <h2>COME HUNGRY</h2>
          <Link href="/menu">Explore the menu</Link>
          <Link href="/rewards">Rewards</Link>
          <Link href="/about">Our story</Link>
          <Link href="/contact">Hours & location</Link>
          <Link href="/terms">Text messaging terms</Link>
          <Link href="/privacy">Privacy policy</Link>
        </nav>
        <div>
          <h2>FIND US</h2>
          <address>{formatAddress(settings)}</address>
          <a className="footer-phone" href={`tel:${settings.public_phone}`}>
            <SiteIcon name="phone" size={17} />
            {settings.public_phone}
          </a>
          <SocialLinks settings={settings} />
        </div>
        <div className="footer-cta">
          <SiteIcon name="pizza" size={37} />
          <h3>
            See you at
            <br />
            pizza time.
          </h3>
          <Link href="/menu">
            Let&apos;s order <SiteIcon name="arrow" size={18} />
          </Link>
        </div>
      </div>
      <div className="site-container footer-bottom">
        <span>
          © {new Date().getFullYear()} {settings.store_name}. All rights
          reserved.
        </span>
        <span>{[settings.city, settings.state].filter(Boolean).join(", ")}</span>
      </div>
    </footer>
  );
}
