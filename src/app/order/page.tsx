import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { Button } from "@/components/ui/button";
import { getStoreSettings } from "@/lib/content/queries";
import { isOnlineOrderingAvailable } from "@/lib/payments/queries";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Start an order" };

export default async function OrderPage() {
  const settings = await getStoreSettings();
  const open = await isOnlineOrderingAvailable(settings);
  return <div className="min-h-screen bg-wayne-cream"><SiteHeader settings={settings} /><main id="main-content" className="mx-auto max-w-5xl px-5 py-16 text-center sm:py-24"><p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Order Wayne&apos;s Pizza</p><h1 className="mt-4 text-5xl font-black sm:text-6xl">How can we make it?</h1><p className="mx-auto mt-5 max-w-xl text-lg text-wayne-muted">Choose pickup or delivery. You can change this before checkout.</p>{!open ? <p className="mx-auto mt-7 max-w-xl rounded-xl border border-wayne-warn/40 bg-wayne-warn-soft p-4 font-bold">Online ordering is currently closed. Please call {settings.public_phone || "Wayne's Pizza"} for help.</p> : null}<div className="mt-10 grid gap-5 sm:grid-cols-2"><OrderOption disabled={!open || !settings.pickup_enabled} href="/menu?fulfillment=pickup" label="Pickup" description={settings.pickup_description} /><OrderOption disabled={!open || !settings.delivery_enabled} href="/menu?fulfillment=delivery" label="Delivery" description={settings.delivery_description} /></div></main><SiteFooter settings={settings} /></div>;
}

function OrderOption({ description, disabled, href, label }: { description: string; disabled: boolean; href: string; label: string }) {
  return <div className="rounded-3xl border border-wayne-border bg-white p-8 shadow-sm"><h2 className="text-4xl font-black">{label}</h2><p className="mt-4 min-h-12 text-wayne-muted">{description}</p><Button asChild className="mt-7 w-full" disabled={disabled}><Link href={href}>{disabled ? "Unavailable" : `Choose ${label.toLowerCase()}`}</Link></Button></div>;
}
