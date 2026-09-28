import type { Metadata } from "next";
import { Archivo, Inter } from "next/font/google";
import { getStoreSettings } from "@/lib/content/queries";
import "./globals.css";
import "./storefront.css";

/** Inter carries the reading; Archivo — a variable face, so font-black is a real 900 — carries the headings. */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo", display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getStoreSettings();
  return {
    title: { default: settings.store_name, template: `%s | ${settings.store_name}` },
    description: settings.seo_home_description,
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html className={`${inter.variable} ${archivo.variable}`} lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
