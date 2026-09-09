import type { MetadataRoute } from "next";
import { getStoreSettings } from "@/lib/content/queries";
export const dynamic = "force-dynamic";
export default async function robots(): Promise<MetadataRoute.Robots> { const settings = await getStoreSettings(); const base = settings.canonical_url || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"; return { rules: { userAgent: "*", allow: "/", disallow: ["/admin/", "/pos/", "/kitchen/", "/driver/"] }, sitemap: `${base}/sitemap.xml` }; }
