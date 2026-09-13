import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getPublicAssetUrl } from "@/lib/images/public-url";
import { isStoreOpenNow } from "@/lib/content/store-status";
import type { StoreSettings } from "@/lib/content/schemas";

const links = [
  { href: "/menu", label: "Menu" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

export function SiteHeader({ settings }: { settings: StoreSettings }) {
  const logoUrl = getPublicAssetUrl(settings.logo_path);
  const open = isStoreOpenNow(settings);

  return (
    <>
      {settings.announcement_text ? (
        <div className="bg-wayne-green px-4 py-2.5 text-center text-sm font-bold text-wayne-cream">
          {settings.announcement_text}
        </div>
      ) : null}

      <header className="sticky top-0 z-40 border-b border-wayne-border bg-wayne-cream/85 backdrop-blur-md">
        <div className="mx-auto flex min-h-20 max-w-7xl items-center gap-4 px-5">
          <Link className="flex items-center gap-3" href="/">
            {logoUrl ? (
              <Image
                alt={settings.logo_alt}
                className="h-12 w-12 rounded-full object-cover ring-2 ring-wayne-green/15"
                height={48}
                src={logoUrl}
                width={48}
              />
            ) : (
              <span className="grid h-12 w-12 place-items-center rounded-full bg-wayne-green font-display text-lg font-black text-wayne-cream">
                W
              </span>
            )}
            <span className="grid">
              <span className="font-display text-xl font-black leading-tight tracking-tight">{settings.store_name}</span>
              {/* Whether they can order right now is the one thing every visitor is checking. */}
              <span className={`flex items-center gap-1.5 text-xs font-bold ${open ? "text-wayne-ok" : "text-wayne-muted"}`}>
                <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${open ? "bg-wayne-ok" : "bg-wayne-muted"}`} />
                {open ? "Open now" : "Closed"}
              </span>
            </span>
          </Link>

          <nav aria-label="Main navigation" className="ml-auto flex items-center gap-1 sm:gap-2">
            {links.map((link) => (
              <Link
                className="hidden rounded-lg px-3 py-2 text-sm font-bold text-wayne-ink transition hover:bg-wayne-cream-deep hover:text-wayne-green sm:inline-block"
                href={link.href}
                key={link.href}
              >
                {link.label}
              </Link>
            ))}
            <Button asChild className="ml-1">
              <Link href="/menu">Order now</Link>
            </Button>
          </nav>
        </div>
      </header>
    </>
  );
}
