"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/access";
import {
  businessHoursSchema,
  dayKeys,
  faqItemSchema,
} from "@/lib/content/schemas";
import { uploadOptimizedImage } from "@/lib/images/upload";
import { parseMoneyToCents } from "@/lib/menu/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const contentSchema = z.object({
  store_name: z.string().trim().min(1).max(120),
  owner_name: z.string().trim().max(120),
  story: z.string().trim().min(1).max(8000),
  owner_story: z.string().trim().max(8000),
  address_line1: z.string().trim().max(200),
  address_line2: z.string().trim().max(200),
  city: z.string().trim().max(120),
  state: z.string().trim().max(80),
  postal_code: z.string().trim().max(20),
  public_phone: z.string().trim().max(40),
  public_email: z.union([z.literal(""), z.email()]),
  timezone: z.string().trim().min(1).max(100),
  service_area_text: z.string().trim().max(1000),
  canonical_url: z.union([z.literal(""), z.url()]),
  facebook_url: z.union([z.literal(""), z.url()]),
  instagram_url: z.union([z.literal(""), z.url()]),
  tiktok_url: z.union([z.literal(""), z.url()]),
  logo_alt: z.string().trim().max(300),
  announcement_text: z.string().trim().max(500),
  homepage_eyebrow: z.string().trim().max(200),
  homepage_heading: z.string().trim().min(1).max(240),
  homepage_description: z.string().trim().max(1000),
  pickup_heading: z.string().trim().min(1).max(100),
  pickup_description: z.string().trim().max(500),
  delivery_heading: z.string().trim().min(1).max(100),
  delivery_description: z.string().trim().max(500),
  about_heading: z.string().trim().min(1).max(240),
  contact_heading: z.string().trim().min(1).max(240),
  ordering_instructions: z.string().trim().max(1500),
  general_notice: z.string().trim().max(1000),
  footer_text: z.string().trim().max(500),
  seo_home_title: z.string().trim().min(1).max(180),
  seo_home_description: z.string().trim().max(500),
  seo_menu_title: z.string().trim().min(1).max(180),
  seo_menu_description: z.string().trim().max(500),
  seo_about_title: z.string().trim().min(1).max(180),
  seo_about_description: z.string().trim().max(500),
  seo_contact_title: z.string().trim().min(1).max(180),
  seo_contact_description: z.string().trim().max(500),
  business_hours: businessHoursSchema,
  faq_items: z.array(faqItemSchema).max(10),
  ordering_open: z.boolean(),
  pickup_enabled: z.boolean(),
  delivery_enabled: z.boolean(),
  pickup_minimum_cents: z.number().int().min(0).max(1_000_000),
  delivery_minimum_cents: z.number().int().min(0).max(1_000_000),
  delivery_fee_cents: z.number().int().min(0).max(1_000_000),
  tax_rate_basis_points: z.number().int().min(0).max(10_000),
  tips_enabled: z.boolean(),
  suggested_tip_percentages: z.array(z.number().int().min(0).max(100)).max(6),
  pickup_prep_minutes: z.number().int().min(0).max(1440),
  delivery_estimate_minutes: z.number().int().min(0).max(1440),
  delivery_area_text: z.string().trim().max(1000),
  delivery_postal_codes: z
    .array(z.string().regex(/^[A-Za-z0-9 -]{3,12}$/))
    .max(100),
  test_ordering_enabled: z.boolean(),
});

function textField(formData: FormData, name: string) {
  return String(formData.get(name) ?? "");
}

function moneyField(formData: FormData, name: string) {
  return parseMoneyToCents(textField(formData, name)) ?? Number.NaN;
}

export async function updateWebsiteSettings(formData: FormData) {
  await requirePermission("content.manage", "/admin/settings");
  const businessHours = Object.fromEntries(
    dayKeys.map((day) => [
      day,
      {
        closed: formData.get(`${day}_closed`) === "on",
        open: textField(formData, `${day}_open`),
        close: textField(formData, `${day}_close`),
      },
    ]),
  ) as Record<
    (typeof dayKeys)[number],
    { closed: boolean; open: string; close: string }
  >;
  const faqItems = [0, 1, 2, 3, 4]
    .map((index) => ({
      question: textField(formData, `faq_${index}_question`),
      answer: textField(formData, `faq_${index}_answer`),
    }))
    .filter((item) => item.question || item.answer);
  const fieldNames = [
    "store_name",
    "owner_name",
    "story",
    "owner_story",
    "address_line1",
    "address_line2",
    "city",
    "state",
    "postal_code",
    "public_phone",
    "public_email",
    "timezone",
    "service_area_text",
    "canonical_url",
    "facebook_url",
    "instagram_url",
    "tiktok_url",
    "logo_alt",
    "announcement_text",
    "homepage_eyebrow",
    "homepage_heading",
    "homepage_description",
    "pickup_heading",
    "pickup_description",
    "delivery_heading",
    "delivery_description",
    "about_heading",
    "contact_heading",
    "ordering_instructions",
    "general_notice",
    "footer_text",
    "seo_home_title",
    "seo_home_description",
    "seo_menu_title",
    "seo_menu_description",
    "seo_about_title",
    "seo_about_description",
    "seo_contact_title",
    "seo_contact_description",
  ] as const;
  const parsed = contentSchema.safeParse({
    ...Object.fromEntries(
      fieldNames.map((name) => [name, textField(formData, name)]),
    ),
    business_hours: businessHours,
    faq_items: faqItems,
    ordering_open: formData.get("ordering_open") === "on",
    pickup_enabled: formData.get("pickup_enabled") === "on",
    delivery_enabled: formData.get("delivery_enabled") === "on",
    pickup_minimum_cents: moneyField(formData, "pickup_minimum"),
    delivery_minimum_cents: moneyField(formData, "delivery_minimum"),
    delivery_fee_cents: moneyField(formData, "delivery_fee"),
    tax_rate_basis_points: Math.round(
      Number(textField(formData, "tax_rate_percent")) * 100,
    ),
    tips_enabled: formData.get("tips_enabled") === "on",
    suggested_tip_percentages: textField(formData, "suggested_tip_percentages")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite),
    pickup_prep_minutes: Number(textField(formData, "pickup_prep_minutes")),
    delivery_estimate_minutes: Number(
      textField(formData, "delivery_estimate_minutes"),
    ),
    delivery_area_text: textField(formData, "delivery_area_text"),
    delivery_postal_codes: textField(formData, "delivery_postal_codes")
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
    test_ordering_enabled: formData.get("test_ordering_enabled") === "on",
  });
  if (!parsed.success)
    redirect(
      `/admin/settings?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid settings")}`,
    );

  let logoPath: string | null = null;
  const logo = formData.get("logo");
  try {
    if (logo instanceof File)
      logoPath = await uploadOptimizedImage(logo, "site");
  } catch (error) {
    redirect(
      `/admin/settings?error=${encodeURIComponent(error instanceof Error ? error.message : "Logo upload failed")}`,
    );
  }
  const supabase = await createServerSupabaseClient();
  const payload = logoPath
    ? { ...parsed.data, logo_path: logoPath }
    : parsed.data;
  const { error } = await supabase
    .from("store_settings")
    .update(payload)
    .eq("id", true);
  if (error)
    redirect(`/admin/settings?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/", "layout");
  revalidatePath("/admin/settings");
  redirect("/admin/settings?saved=1");
}

const specialHoursInput = z
  .object({
    service_date: z.iso.date(),
    label: z.string().trim().max(160),
    closed: z.boolean(),
    opens_at: z.string(),
    closes_at: z.string(),
    public_note: z.string().trim().max(500),
  })
  .refine(
    (value) =>
      value.closed ||
      (/^\d{2}:\d{2}$/.test(value.opens_at) &&
        /^\d{2}:\d{2}$/.test(value.closes_at)),
    { message: "Open special hours require opening and closing times." },
  );

export async function saveSpecialHours(formData: FormData) {
  await requirePermission("content.manage", "/admin/settings");
  const parsed = specialHoursInput.safeParse({
    service_date: textField(formData, "service_date"),
    label: textField(formData, "label"),
    closed: formData.get("closed") === "on",
    opens_at: textField(formData, "opens_at"),
    closes_at: textField(formData, "closes_at"),
    public_note: textField(formData, "public_note"),
  });
  if (!parsed.success)
    redirect(
      `/admin/settings?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid special hours")}`,
    );
  const data = {
    ...parsed.data,
    opens_at: parsed.data.closed ? null : parsed.data.opens_at,
    closes_at: parsed.data.closed ? null : parsed.data.closes_at,
  };
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.from("store_special_hours").insert(data);
  if (error)
    redirect(`/admin/settings?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/", "layout");
  revalidatePath("/admin/settings");
  redirect("/admin/settings?saved=1");
}

export async function updateSpecialHours(formData: FormData) {
  await requirePermission("content.manage", "/admin/settings");
  const id = z.uuid().safeParse(formData.get("id"));
  const parsed = specialHoursInput.safeParse({
    service_date: textField(formData, "service_date"),
    label: textField(formData, "label"),
    closed: formData.get("closed") === "on",
    opens_at: textField(formData, "opens_at"),
    closes_at: textField(formData, "closes_at"),
    public_note: textField(formData, "public_note"),
  });
  if (!id.success || !parsed.success)
    redirect(
      `/admin/settings?error=${encodeURIComponent(parsed.success ? "Invalid special hours" : (parsed.error.issues[0]?.message ?? "Invalid special hours"))}`,
    );
  const data = {
    ...parsed.data,
    opens_at: parsed.data.closed ? null : parsed.data.opens_at,
    closes_at: parsed.data.closed ? null : parsed.data.closes_at,
  };
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("store_special_hours")
    .update(data)
    .eq("id", id.data)
    .is("archived_at", null);
  if (error)
    redirect(`/admin/settings?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/", "layout");
  revalidatePath("/admin/settings");
  redirect("/admin/settings?saved=1");
}

export async function archiveSpecialHours(formData: FormData) {
  await requirePermission("content.manage", "/admin/settings");
  const id = z.uuid().safeParse(formData.get("id"));
  if (!id.success) redirect("/admin/settings?error=Invalid%20special%20hours");
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from("store_special_hours")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id.data);
  if (error)
    redirect(`/admin/settings?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/", "layout");
  revalidatePath("/admin/settings");
  redirect("/admin/settings?saved=1");
}
