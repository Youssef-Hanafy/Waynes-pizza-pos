import type { MetadataRoute } from "next";
import { getStorefront } from "@/lib/content/queries";
export const dynamic = "force-dynamic";
export default async function robots(): Promise<MetadataRoute.Robots> { const { known, settings } = await getStorefront(); if (!known) return { rules: { userAgent: "*", disallow: "/" } }; const base = settings.canonical_url || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"; return { rules: { userAgent: "*", allow: "/", disallow: ["/admin/", "/pos/", "/kitchen/", "/driver/", "/r/"] }, sitemap: `${base}/sitemap.xml` }; }
