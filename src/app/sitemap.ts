import type { MetadataRoute } from "next";
import { getStoreSettings } from "@/lib/content/queries";
export const dynamic = "force-dynamic";
export default async function sitemap(): Promise<MetadataRoute.Sitemap> { const settings = await getStoreSettings(); const base = settings.canonical_url || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"; return ["", "/menu", "/about", "/contact", "/rewards", "/terms", "/privacy"].map((path, index) => ({ url: `${base}${path}`, changeFrequency: index < 2 ? "weekly" : "monthly", priority: index === 0 ? 1 : 0.8 })); }
