import Image from "next/image";
import Link from "next/link";
import { getPublicAssetUrl } from "@/lib/images/public-url";
import type { StoreSettings } from "@/lib/content/schemas";

export function SiteHeader({ settings }: { settings: StoreSettings }) {
  const logoUrl = getPublicAssetUrl(settings.logo_path);
  return (
    <>
      {settings.announcement_text ? (
        <div className="bg-wayne-red px-4 py-2 text-center text-sm font-bold text-white">
          {settings.announcement_text}
        </div>
      ) : null}
      <header className="border-b border-wayne-border bg-wayne-cream/95 backdrop-blur">
        <div className="mx-auto flex min-h-20 max-w-7xl items-center justify-between gap-6 px-5">
          <Link
            className="flex items-center gap-3 text-xl font-black tracking-tight"
            href="/"
          >
            {logoUrl ? (
              <Image
                alt={settings.logo_alt}
                className="h-12 w-12 rounded-full object-cover"
                height={48}
                src={logoUrl}
                width={48}
              />
            ) : (
              <span className="grid h-11 w-11 place-items-center rounded-full bg-wayne-red text-white">
                W
              </span>
            )}
            <span>{settings.store_name}</span>
          </Link>
          <nav
            aria-label="Main navigation"
            className="flex items-center gap-4 text-sm font-bold sm:gap-6"
          >
            <Link className="hover:text-wayne-red" href="/menu">
              Menu
            </Link>
            <Link
              className="hidden hover:text-wayne-red sm:inline"
              href="/about"
            >
              About
            </Link>
            <Link
              className="hidden hover:text-wayne-red sm:inline"
              href="/contact"
            >
              Contact
            </Link>
          </nav>
        </div>
      </header>
    </>
  );
}
