import type { Metadata } from "next";
import { Archivo, Inter } from "next/font/google";
import "./globals.css";
import "./storefront.css";

/** Inter carries the reading; Archivo — a variable face, so font-black is a real 900 — carries the headings. */
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const archivo = Archivo({ subsets: ["latin"], variable: "--font-archivo", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Wayne's Pizza", template: "%s | Wayne's Pizza" },
  description: "Wayne's Pizza operating system"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html className={`${inter.variable} ${archivo.variable}`} lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
