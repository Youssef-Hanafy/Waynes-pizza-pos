import { z } from "zod";

/** Platform Admin → Domains & storefront (Phase 13, build sheet §13). */
export const storefrontFields = [
  ["store_name", "Business name on the website", 120],
  ["homepage_eyebrow", "Small line above the headline", 160],
  ["homepage_heading", "Homepage headline", 160],
  ["homepage_description", "Homepage text", 600],
  ["story", "About text", 4000],
  ["public_phone", "Public phone", 40],
  ["public_email", "Public email", 254],
  ["seo_home_title", "Search title", 120],
  ["seo_home_description", "Search description", 300],
  ["announcement_text", "Announcement bar", 300],
  ["footer_text", "Footer text", 300],
] as const;
export type StorefrontField = (typeof storefrontFields)[number][0];

export const platformDomainsSchema = z.object({
  can_manage: z.boolean(),
  workspace_status: z.string(),
  domains: z.array(z.object({
    id: z.uuid(), hostname: z.string(), location_id: z.uuid(), location_name: z.string(), is_canonical: z.boolean(), active: z.boolean(),
    resolves: z.boolean(), created_at: z.string(),
  })),
  locations: z.array(z.object({ id: z.uuid(), name: z.string(), status: z.string(), storefront: z.record(z.string(), z.unknown()) })),
  brand_colors: z.record(z.string(), z.unknown()),
  services: z.array(z.string()),
  legacy: z.boolean(),
});
export type PlatformDomains = z.infer<typeof platformDomainsSchema>;

export const domainResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), id: z.uuid().nullable().optional() }),
  z.object({ status: z.literal("needs_confirmation"), warnings: z.array(z.string()) }),
]);

/** What a person typed into "web address" → a bare lowercase host, or null. */
export function cleanHostname(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.+$/, "");
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) && host.length <= 253 ? host : null;
}
