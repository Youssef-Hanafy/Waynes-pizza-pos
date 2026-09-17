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
});

export type BusinessHours = z.infer<typeof businessHoursSchema>;
export type StoreSettings = z.infer<typeof storeSettingsSchema>;

export const defaultSettings: StoreSettings = {
  id: true,
  store_name: "Wayne's Pizza",
  owner_name: "",
  story:
    "Wayne's Pizza is a longtime Worcester neighborhood pizza shop that has been serving the community for over 50 years. The restaurant specializes in Greek- and Italian-style pizza along with calzones, subs, salads, pasta, fried foods, and other classic pizza-shop favorites.",
  owner_story: "",
  address_line1: "93 West Boylston St.",
  address_line2: "",
  city: "Worcester",
  state: "MA",
  postal_code: "01606",
  public_phone: "(508) 852-6326",
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
  delivery_area_text: "Delivery eligibility is confirmed at checkout.",
  delivery_postal_codes: [],
  test_ordering_enabled: true,
  service_area_text: "Serving Worcester and the surrounding neighborhood.",
  canonical_url: "https://waynespizzaofworcester.com",
  facebook_url: "",
  instagram_url: "",
  tiktok_url: "",
  logo_path: null,
  logo_alt: "Wayne's Pizza logo",
  announcement_text: "",
  homepage_eyebrow: "Worcester's neighborhood pizza shop",
  homepage_heading: "Hot pizza. Your way.",
  homepage_description:
    "Choose pickup or delivery, then explore Wayne's current menu.",
  pickup_heading: "Pickup",
  pickup_description: "Order ahead and pick it up fresh at Wayne's.",
  delivery_heading: "Delivery",
  delivery_description:
    "See delivery availability and bring Wayne's to your door.",
  about_heading: "A Worcester favorite for over 50 years",
  contact_heading: "Visit or call Wayne's",
  ordering_instructions:
    "Choose pickup or delivery, customize your meal, and place a clearly labeled test/manual order. No card payment is collected.",
  general_notice: "",
  footer_text: "Wayne's Pizza — Worcester, Massachusetts",
  seo_home_title: "Wayne's Pizza | Worcester, MA",
  seo_home_description:
    "Explore Wayne's Pizza in Worcester, Massachusetts—serving Greek- and Italian-style pizza and classic pizza-shop favorites for over 50 years.",
  seo_menu_title: "Menu",
  seo_menu_description:
    "Browse the current Wayne's Pizza menu for pickup or delivery in Worcester.",
  seo_about_title: "About Wayne's Pizza",
  seo_about_description:
    "Learn about Wayne's Pizza, a longtime Worcester neighborhood pizza shop serving the community for over 50 years.",
  seo_contact_title: "Contact Wayne's Pizza",
  seo_contact_description:
    "Find Wayne's Pizza hours, phone number, and location at 93 West Boylston St. in Worcester, Massachusetts.",
  faq_items: [
    {
      question: "Do you offer pickup?",
      answer: "Yes. Choose Pickup above to browse the current menu.",
    },
    {
      question: "Do you offer delivery?",
      answer:
        "Delivery availability and service area are shown before ordering.",
    },
  ],
  special_hours: [],
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
