import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import type { StoreSettings } from "@/lib/content/schemas";

/** Shared frame for the SMS Terms and Privacy Policy pages. */
export function LegalPage({ settings, eyebrow, title, updated, children }: { settings: StoreSettings; eyebrow: string; title: string; updated: string; children: ReactNode }) {
  return <div className="storefront min-h-screen">
    <SiteHeader settings={settings} />
    <main id="main-content" className="mx-auto max-w-3xl px-5 py-16 sm:py-20">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">{eyebrow}</p>
      <h1 className="mt-3 text-4xl font-black tracking-tight sm:text-5xl">{title}</h1>
      <p className="mt-3 text-sm text-wayne-muted">Last updated {updated}</p>
      <div className="legal-copy mt-8 grid gap-6 text-lg leading-8 text-wayne-ink [&_h2]:mt-4 [&_h2]:text-2xl [&_h2]:font-black [&_li]:ml-6 [&_li]:list-disc [&_a]:font-bold [&_a]:underline">{children}</div>
    </main>
    <SiteFooter settings={settings} />
  </div>;
}
