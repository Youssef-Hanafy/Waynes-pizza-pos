import type { Metadata } from "next";
import { Archivo, Inter } from "next/font/google";
import { StorefrontBrandProvider } from "@/components/site/storefront-brand";
import { getStorefront } from "@/lib/content/queries";
import { brandNames } from "@/lib/content/schemas";
import "./globals.css";
import "./storefront.css";

/** Inter carries the reading; Archivo — a variable face, so font-black is a real 900 — carries the headings. */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo", display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  const { known, settings } = await getStorefront();
  // A host no workspace has claimed (a preview URL, a register on the app
  // domain) carries the platform name, never another business's.
  const name = known ? settings.store_name : "Hanafy";
  return {
    title: { default: name, template: `%s | ${name}` },
    description: known ? settings.seo_home_description : undefined,
  };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { settings, services, workspace } = await getStorefront();
  // Tenant theme (Phase 13): a business's brand colour replaces the default accent.
  const primary = workspace?.brand_colors?.primary;
  const theme = primary ? ({ "--color-wayne-red": primary, "--color-wayne-red-dark": `color-mix(in srgb, ${primary} 80%, black)`, "--color-wayne-red-soft": `color-mix(in srgb, ${primary} 12%, white)` } as React.CSSProperties) : undefined;
  return (
    <html className={`${inter.variable} ${archivo.variable}`} lang="en">
      <body className="font-sans antialiased" style={theme}><StorefrontBrandProvider brand={{ ...brandNames(settings), services, city: settings.city, state: settings.state }}>{children}</StorefrontBrandProvider></body>
    </html>
  );
}
