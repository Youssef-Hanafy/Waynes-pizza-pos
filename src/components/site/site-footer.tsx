import Link from "next/link";
import { formatAddress, type StoreSettings } from "@/lib/content/schemas";

export function SiteFooter({ settings }: { settings: StoreSettings }) {
  const socialLinks = [
    { href: settings.facebook_url, label: "Facebook" },
    { href: settings.instagram_url, label: "Instagram" },
  ].filter((link) => link.href);

  return (
    <footer className="mt-auto border-t-4 border-wayne-red bg-wayne-green text-wayne-cream">
      <div className="mx-auto grid max-w-7xl gap-10 px-5 py-12 md:grid-cols-[1.4fr_auto_auto]">
        <div>
          <p className="font-display text-2xl font-black tracking-tight">{settings.store_name}</p>
          <p className="mt-3 max-w-md text-sm leading-6 text-wayne-cream/70">{settings.footer_text}</p>
        </div>

        <nav aria-label="Footer navigation" className="grid content-start gap-2 text-sm font-semibold">
          <Link className="text-wayne-cream/80 transition hover:text-wayne-cream" href="/menu">Menu</Link>
          <Link className="text-wayne-cream/80 transition hover:text-wayne-cream" href="/about">About</Link>
          <Link className="text-wayne-cream/80 transition hover:text-wayne-cream" href="/contact">Contact</Link>
        </nav>

        <address className="grid content-start gap-2 text-sm not-italic leading-6 text-wayne-cream/70">
          <p>{formatAddress(settings)}</p>
          {settings.public_phone ? (
            <a className="font-display text-xl font-black tracking-tight text-wayne-cream" href={`tel:${settings.public_phone}`}>
              {settings.public_phone}
            </a>
          ) : null}
          {socialLinks.length ? (
            <div className="flex gap-4 pt-1">
              {socialLinks.map((link) => (
                <a className="font-semibold text-wayne-cream/80 transition hover:text-wayne-cream" href={link.href} key={link.label} rel="noreferrer" target="_blank">
                  {link.label}
                </a>
              ))}
            </div>
          ) : null}
        </address>
      </div>
      <div className="border-t border-wayne-cream/15 px-5 py-4 text-center text-xs text-wayne-cream/50">
        © {new Date().getFullYear()} {settings.store_name}
      </div>
    </footer>
  );
}
