import Link from "next/link";
import { formatAddress, type StoreSettings } from "@/lib/content/schemas";
import { BrandMark } from "./brand-mark";
import { SiteIcon } from "./site-icon";
export function SiteFooter({ settings }: { settings: StoreSettings }) {
  return (
    <footer className="site-footer">
      <div className="checker-strip" aria-hidden />
      <div className="site-container footer-grid">
        <div>
          <Link href="/" className="footer-brand">
            <BrandMark />
          </Link>
          <p>
            Big flavor. Local love.
            <br />
            Your neighborhood pizza place for over 50 years.
          </p>
        </div>
        <nav aria-label="Footer navigation">
          <h2>COME HUNGRY</h2>
          <Link href="/menu">Explore the menu</Link>
          <Link href="/rewards">Wayne’s Text Daily</Link>
          <Link href="/about">The Wayne&apos;s story</Link>
          <Link href="/contact">Hours & location</Link>
        </nav>
        <div>
          <h2>FIND YOUR WAYNE’S</h2>
          <address>{formatAddress(settings)}</address>
          <a className="footer-phone" href={`tel:${settings.public_phone}`}>
            <SiteIcon name="phone" size={17} />
            {settings.public_phone}
          </a>
          {settings.facebook_url && (
            <a href={settings.facebook_url} target="_blank" rel="noreferrer">
              Facebook ↗
            </a>
          )}
          {settings.instagram_url && (
            <a href={settings.instagram_url} target="_blank" rel="noreferrer">
              Instagram ↗
            </a>
          )}
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
        <span>Made for Worcester. Made for you.</span>
      </div>
    </footer>
  );
}
