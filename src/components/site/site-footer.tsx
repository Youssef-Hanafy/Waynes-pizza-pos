import Link from "next/link";
import { formatAddress, type StoreSettings } from "@/lib/content/schemas";

export function SiteFooter({ settings }: { settings: StoreSettings }) {
  const socialLinks = [{ href: settings.facebook_url, label: "Facebook" }, { href: settings.instagram_url, label: "Instagram" }].filter((link) => link.href);
  return <footer className="border-t border-wayne-border bg-wayne-ink text-wayne-cream"><div className="mx-auto grid max-w-7xl gap-8 px-5 py-10 md:grid-cols-[1fr_auto_auto]"><div><p className="text-xl font-black">{settings.store_name}</p><p className="mt-2 max-w-md text-sm text-stone-300">{settings.footer_text}</p></div><div className="grid gap-2 text-sm"><Link href="/menu">Menu</Link><Link href="/about">About</Link><Link href="/contact">Contact</Link></div><address className="not-italic text-sm leading-6 text-stone-300"><p>{formatAddress(settings)}</p>{settings.public_phone ? <a className="text-white" href={`tel:${settings.public_phone}`}>{settings.public_phone}</a> : null}{socialLinks.length ? <div className="mt-2 flex gap-3">{socialLinks.map((link) => <a href={link.href} key={link.label} rel="noreferrer" target="_blank">{link.label}</a>)}</div> : null}</address></div><div className="border-t border-white/10 px-5 py-4 text-center text-xs text-stone-400">© {new Date().getFullYear()} {settings.store_name}</div></footer>;
}
