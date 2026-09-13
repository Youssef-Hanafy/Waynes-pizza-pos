import type { Metadata } from "next";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { getStoreSettings } from "@/lib/content/queries";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> { const settings = await getStoreSettings(); return { title: settings.seo_about_title, description: settings.seo_about_description, alternates: { canonical: settings.canonical_url ? `${settings.canonical_url}/about` : "/about" } }; }
export default async function AboutPage() { const settings = await getStoreSettings(); return <div className="storefront min-h-screen"><SiteHeader settings={settings} /><main id="main-content" className="mx-auto max-w-4xl px-5 py-16 sm:py-24"><p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">About us</p><h1 className="mt-3 text-5xl font-black tracking-tight">{settings.about_heading}</h1><p className="mt-8 whitespace-pre-line text-xl leading-9 text-wayne-muted">{settings.story}</p>{settings.owner_story ? <section className="mt-12 rounded-3xl border border-wayne-border bg-white p-8"><h2 className="text-3xl font-black">Our family story</h2><p className="mt-4 whitespace-pre-line leading-8 text-wayne-muted">{settings.owner_story}</p></section> : null}</main><SiteFooter settings={settings} /></div>; }
