import { z } from "zod";

export const dayKeys = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;
export type DayKey = (typeof dayKeys)[number];

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);

export const dayHoursSchema = z
  .object({
    closed: z.boolean(),
    open: z.union([timeSchema, z.literal("")]),
    close: z.union([timeSchema, z.literal("")]),
  })
  .refine(
    (value) => value.closed || (value.open !== "" && value.close !== ""),
    {
      message: "Open days require opening and closing times.",
    },
  );

export const businessHoursSchema = z.object(
  Object.fromEntries(dayKeys.map((day) => [day, dayHoursSchema])) as Record<
    DayKey,
    typeof dayHoursSchema
  >,
);

export const faqItemSchema = z.object({
  question: z.string().trim().min(1).max(240),
  answer: z.string().trim().min(1).max(1200),
});

export const specialHoursSchema = z.object({
  id: z.uuid(),
  service_date: z.iso.date(),
  label: z.string(),
  closed: z.boolean(),
  opens_at: z.string().nullable(),
  closes_at: z.string().nullable(),
  public_note: z.string(),
});

export const storeSettingsSchema = z.object({
  id: z.boolean(),
  store_name: z.string(),
  owner_name: z.string(),
  story: z.string(),
  owner_story: z.string(),
  address_line1: z.string(),
  address_line2: z.string(),
  city: z.string(),
  state: z.string(),
  postal_code: z.string(),
  public_phone: z.string(),
  public_email: z.string(),
  timezone: z.string(),
  business_hours: businessHoursSchema,
  ordering_open: z.boolean(),
  pickup_enabled: z.boolean(),
  delivery_enabled: z.boolean(),
  pickup_minimum_cents: z.number().int().nonnegative(),
  delivery_minimum_cents: z.number().int().nonnegative(),
  delivery_fee_cents: z.number().int().nonnegative(),
  tax_rate_basis_points: z.number().int().min(0).max(10000),
  tips_enabled: z.boolean(),
  suggested_tip_percentages: z.array(z.number().int().min(0).max(100)),
  pickup_prep_minutes: z.number().int().min(0).max(1440),
  delivery_estimate_minutes: z.number().int().min(0).max(1440),
  delivery_area_text: z.string(),
  delivery_postal_codes: z.array(z.string()),
  test_ordering_enabled: z.boolean(),
  service_area_text: z.string(),
  canonical_url: z.string(),
  facebook_url: z.string(),
  instagram_url: z.string(),
  tiktok_url: z.string(),
  logo_path: z.string().nullable(),
  logo_alt: z.string(),
  announcement_text: z.string(),
  homepage_eyebrow: z.string(),
  homepage_heading: z.string(),
  homepage_description: z.string(),
  pickup_heading: z.string(),
  pickup_description: z.string(),
  delivery_heading: z.string(),
  delivery_description: z.string(),
  about_heading: z.string(),
  contact_heading: z.string(),
  ordering_instructions: z.string(),
  general_notice: z.string(),
  footer_text: z.string(),
  seo_home_title: z.string(),
  seo_home_description: z.string(),
  seo_menu_title: z.string(),
  seo_menu_description: z.string(),
  seo_about_title: z.string(),
  seo_about_description: z.string(),
  seo_contact_title: z.string(),
  seo_contact_description: z.string(),
  faq_items: z.array(faqItemSchema),
  special_hours: z.array(specialHoursSchema),
  // Phase 4.1 brand names used in storefront copy (empty → derived from store_name).
  brand_name: z.string().max(80).default(""),
  brand_short_name: z.string().max(60).default(""),
  rewards_program_name: z.string().max(80).default(""),
});

export type BusinessHours = z.infer<typeof businessHoursSchema>;
export type StoreSettings = z.infer<typeof storeSettingsSchema>;

/** Safe failure state. It is deliberately not a tenant's branding or data. */
export const defaultSettings: StoreSettings = {
  id: true,
  store_name: "Store unavailable",
  owner_name: "",
  story: "This storefront has not been configured for this domain.",
  owner_story: "",
  address_line1: "",
  address_line2: "",
  city: "",
  state: "",
  postal_code: "",
  public_phone: "",
  public_email: "",
  timezone: "America/New_York",
  business_hours: Object.fromEntries(
    dayKeys.map((day) => [
      day,
      { closed: false, open: "11:00", close: "22:00" },
    ]),
  ) as BusinessHours,
  ordering_open: true,
  pickup_enabled: true,
  delivery_enabled: true,
  pickup_minimum_cents: 0,
  delivery_minimum_cents: 0,
  delivery_fee_cents: 0,
  tax_rate_basis_points: 0,
  tips_enabled: false,
  suggested_tip_percentages: [15, 20, 25],
  pickup_prep_minutes: 25,
  delivery_estimate_minutes: 45,
  delivery_area_text: "",
  delivery_postal_codes: [],
  test_ordering_enabled: true,
  service_area_text: "",
  canonical_url: "",
  facebook_url: "",
  instagram_url: "",
  tiktok_url: "",
  logo_path: null,
  logo_alt: "Store logo",
  announcement_text: "",
  homepage_eyebrow: "",
  homepage_heading: "Storefront unavailable",
  homepage_description: "This domain is not configured.",
  pickup_heading: "Pickup",
  pickup_description: "",
  delivery_heading: "Delivery",
  delivery_description: "",
  about_heading: "About",
  contact_heading: "Contact",
  ordering_instructions: "",
  general_notice: "",
  footer_text: "",
  seo_home_title: "Store unavailable",
  seo_home_description: "This domain is not configured.",
  seo_menu_title: "Menu",
  seo_menu_description: "",
  seo_about_title: "About",
  seo_about_description: "",
  seo_contact_title: "Contact",
  seo_contact_description: "",
  faq_items: [],
  special_hours: [],
  brand_name: "",
  brand_short_name: "",
  rewards_program_name: "",
};

export function formatTime(value: string) {
  const [hourText, minute = "00"] = value.split(":");
  const hour = Number(hourText);
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}

export function formatAddress(settings: StoreSettings) {
  return [
    settings.address_line1,
    settings.address_line2,
    [settings.city, settings.state, settings.postal_code]
      .filter(Boolean)
      .join(" "),
  ]
    .filter(Boolean)
    .join(", ");
}

export type BrandNames = { storeName: string; brandName: string; shortName: string; rewardsName: string };

/**
 * The names storefront copy uses.  Each is workspace configuration with a
 * sensible derivation, so a new business reads correctly with no code change.
 */
export function brandNames(settings: Pick<StoreSettings, "store_name" | "brand_name" | "brand_short_name" | "rewards_program_name">): BrandNames {
  const storeName = settings.store_name.trim() || "Our store";
  const brandName = settings.brand_name.trim() || storeName;
  const shortName = settings.brand_short_name.trim() || brandName;
  const rewardsName = settings.rewards_program_name.trim() || `${shortName} Rewards`;
  return { storeName, brandName, shortName, rewardsName };
}
