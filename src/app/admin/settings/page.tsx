import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/access";
import { getStoreSettings } from "@/lib/content/queries";
import { dayKeys, type StoreSettings } from "@/lib/content/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  archiveSpecialHours,
  saveSpecialHours,
  updateSpecialHours,
  updateWebsiteSettings,
} from "./actions";

export const metadata: Metadata = { title: "Website settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  await requirePermission("content.manage", "/admin/settings");
  const [settings, params] = await Promise.all([
    getStoreSettings(),
    searchParams,
  ]);
  const supabase = await createServerSupabaseClient();
  const { data: specialHours } = await supabase
    .from("store_special_hours")
    .select("id,service_date,label,closed,opens_at,closes_at,public_note")
    .is("archived_at", null)
    .order("service_date");

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">
        Website
      </p>
      <h1 className="mt-3 text-4xl font-black">Content & business settings</h1>
      <p className="mt-3 max-w-3xl text-wayne-muted">
        This database record is the public website&apos;s source of truth. Saved
        changes appear without changing source code.
      </p>
      {params.saved ? <Notice kind="success">Changes saved.</Notice> : null}
      {params.error ? <Notice kind="error">{params.error}</Notice> : null}
      <form action={updateWebsiteSettings} className="mt-8 grid gap-6">
        <SettingsSection title="Business identity">
          <div className="grid gap-4 md:grid-cols-2">
            <Input
              defaultValue={settings.store_name}
              label="Business name"
              name="store_name"
              required
            />
            <Input
              defaultValue={settings.owner_name}
              label="Owner name (optional)"
              name="owner_name"
            />
            <Input
              defaultValue={settings.address_line1}
              label="Address line 1"
              name="address_line1"
            />
            <Input
              defaultValue={settings.address_line2}
              label="Address line 2"
              name="address_line2"
            />
            <Input defaultValue={settings.city} label="City" name="city" />
            <Input defaultValue={settings.state} label="State" name="state" />
            <Input
              defaultValue={settings.postal_code}
              label="Postal code"
              name="postal_code"
            />
            <Input
              defaultValue={settings.public_phone}
              label="Public phone"
              name="public_phone"
            />
            <Input
              defaultValue={settings.public_email}
              label="Public email (optional)"
              name="public_email"
              type="email"
            />
            <Input
              defaultValue={settings.timezone}
              label="Timezone"
              name="timezone"
              required
            />
          </div>
          <TextArea
            defaultValue={settings.service_area_text}
            label="Service area / local information"
            name="service_area_text"
            rows={3}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <Input
              defaultValue={settings.canonical_url}
              label="Canonical website URL"
              name="canonical_url"
              type="url"
            />
            <Input
              defaultValue={settings.logo_alt}
              label="Logo alt text"
              name="logo_alt"
            />
            <Input
              accept="image/jpeg,image/png,image/webp,image/avif"
              label="Replace logo (optional, 5 MB max)"
              name="logo"
              type="file"
            />
          </div>
        </SettingsSection>
        <SettingsSection title="Homepage & ordering copy">
          <Input
            defaultValue={settings.announcement_text}
            label="Announcement banner (blank hides it)"
            name="announcement_text"
          />
          <Input
            defaultValue={settings.homepage_eyebrow}
            label="Hero eyebrow"
            name="homepage_eyebrow"
          />
          <Input
            defaultValue={settings.homepage_heading}
            label="Hero heading"
            name="homepage_heading"
            required
          />
          <TextArea
            defaultValue={settings.homepage_description}
            label="Hero description"
            name="homepage_description"
            rows={3}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <Input
              defaultValue={settings.pickup_heading}
              label="Pickup heading"
              name="pickup_heading"
              required
            />
            <Input
              defaultValue={settings.delivery_heading}
              label="Delivery heading"
              name="delivery_heading"
              required
            />
            <TextArea
              defaultValue={settings.pickup_description}
              label="Pickup description"
              name="pickup_description"
              rows={3}
            />
            <TextArea
              defaultValue={settings.delivery_description}
              label="Delivery description"
              name="delivery_description"
              rows={3}
            />
          </div>
          <TextArea
            defaultValue={settings.ordering_instructions}
            label="Ordering instructions"
            name="ordering_instructions"
            rows={3}
          />
          <TextArea
            defaultValue={settings.general_notice}
            label="General website notice (blank hides it)"
            name="general_notice"
            rows={3}
          />
          <div className="flex flex-wrap gap-5">
            <Check
              defaultChecked={settings.ordering_open}
              label="Ordering open"
              name="ordering_open"
            />
            <Check
              defaultChecked={settings.pickup_enabled}
              label="Pickup enabled"
              name="pickup_enabled"
            />
            <Check
              defaultChecked={settings.delivery_enabled}
              label="Delivery enabled"
              name="delivery_enabled"
            />
          </div>
        </SettingsSection>
        <SettingsSection title="Online ordering operations">
          <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-950">
            Phase 2 accepts TEST / MANUAL orders only. No card payment is
            collected. Confirm the tax rate with Wayne&apos;s accountant before
            production use.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <Input
              defaultValue={(settings.pickup_minimum_cents / 100).toFixed(2)}
              inputMode="decimal"
              label="Pickup minimum ($)"
              name="pickup_minimum"
              required
            />
            <Input
              defaultValue={(settings.delivery_minimum_cents / 100).toFixed(2)}
              inputMode="decimal"
              label="Delivery minimum ($)"
              name="delivery_minimum"
              required
            />
            <Input
              defaultValue={(settings.delivery_fee_cents / 100).toFixed(2)}
              inputMode="decimal"
              label="Delivery fee ($)"
              name="delivery_fee"
              required
            />
            <Input
              defaultValue={(settings.tax_rate_basis_points / 100).toFixed(2)}
              inputMode="decimal"
              label="Configured tax rate (%)"
              name="tax_rate_percent"
              required
            />
            <Input
              defaultValue={settings.pickup_prep_minutes}
              label="Pickup estimate (minutes)"
              name="pickup_prep_minutes"
              required
              type="number"
            />
            <Input
              defaultValue={settings.delivery_estimate_minutes}
              label="Delivery estimate (minutes)"
              name="delivery_estimate_minutes"
              required
              type="number"
            />
            <Input
              defaultValue={settings.suggested_tip_percentages.join(", ")}
              label="Suggested tips (%)"
              name="suggested_tip_percentages"
            />
          </div>
          <TextArea
            defaultValue={settings.delivery_area_text}
            label="Delivery area instructions"
            name="delivery_area_text"
            rows={3}
          />
          <Input
            defaultValue={settings.delivery_postal_codes.join(", ")}
            label="Allowed delivery postal codes (comma-separated; blank allows all)"
            name="delivery_postal_codes"
          />
          <div className="flex flex-wrap gap-5">
            <Check
              defaultChecked={settings.test_ordering_enabled}
              label="Accept TEST / MANUAL orders"
              name="test_ordering_enabled"
            />
            <Check
              defaultChecked={settings.tips_enabled}
              label="Allow tips"
              name="tips_enabled"
            />
          </div>
        </SettingsSection>
        <SettingsSection title="About, contact & footer">
          <Input
            defaultValue={settings.about_heading}
            label="About heading"
            name="about_heading"
            required
          />
          <TextArea
            defaultValue={settings.story}
            label="About Wayne's"
            name="story"
            required
            rows={8}
          />
          <TextArea
            defaultValue={settings.owner_story}
            label="Owner / family story (blank hides it)"
            name="owner_story"
            rows={8}
          />
          <Input
            defaultValue={settings.contact_heading}
            label="Contact heading"
            name="contact_heading"
            required
          />
          <Input
            defaultValue={settings.footer_text}
            label="Footer text"
            name="footer_text"
          />
          <div className="grid gap-4 md:grid-cols-2">
            <Input
              defaultValue={settings.facebook_url}
              label="Facebook URL (optional)"
              name="facebook_url"
              type="url"
            />
            <Input
              defaultValue={settings.instagram_url}
              label="Instagram URL (optional)"
              name="instagram_url"
              type="url"
            />
          </div>
        </SettingsSection>
        <SettingsSection title="Regular hours">
          <div className="grid gap-3">
            {dayKeys.map((day) => {
              const hours = settings.business_hours[day];
              return (
                <div
                  className="grid items-end gap-3 rounded-xl border border-wayne-border p-4 sm:grid-cols-[8rem_1fr_1fr_auto]"
                  key={day}
                >
                  <strong className="capitalize sm:pb-3">{day}</strong>
                  <Input
                    defaultValue={hours.open}
                    label="Opens"
                    name={`${day}_open`}
                    type="time"
                  />
                  <Input
                    defaultValue={hours.close}
                    label="Closes"
                    name={`${day}_close`}
                    type="time"
                  />
                  <Check
                    defaultChecked={hours.closed}
                    label="Closed"
                    name={`${day}_closed`}
                  />
                </div>
              );
            })}
          </div>
        </SettingsSection>
        <SettingsSection title="Frequently asked questions">
          <p className="text-sm text-wayne-muted">
            Leave both fields blank to hide a row.
          </p>
          {[0, 1, 2, 3, 4].map((index) => (
            <div
              className="grid gap-3 rounded-xl border border-wayne-border p-4"
              key={index}
            >
              <Input
                defaultValue={settings.faq_items[index]?.question ?? ""}
                label={`Question ${index + 1}`}
                name={`faq_${index}_question`}
              />
              <TextArea
                defaultValue={settings.faq_items[index]?.answer ?? ""}
                label="Answer"
                name={`faq_${index}_answer`}
                rows={3}
              />
            </div>
          ))}
        </SettingsSection>
        <SettingsSection title="Search & social previews">
          <SeoFields settings={settings} />
        </SettingsSection>
        <div className="sticky bottom-4 flex justify-end">
          <Button className="min-w-40 shadow-lg" type="submit">
            Save website settings
          </Button>
        </div>
      </form>
      <Card className="mt-10 p-6">
        <h2 className="text-2xl font-black">Holiday / special hours</h2>
        <p className="mt-2 text-sm text-wayne-muted">
          One active override per date. Archive an old entry before replacing
          it.
        </p>
        <form
          action={saveSpecialHours}
          className="mt-5 grid gap-4 md:grid-cols-2"
        >
          <Input label="Date" name="service_date" required type="date" />
          <Input label="Label (for example, Thanksgiving)" name="label" />
          <Input label="Opens" name="opens_at" type="time" />
          <Input label="Closes" name="closes_at" type="time" />
          <Input
            className="md:col-span-2"
            label="Public note"
            name="public_note"
          />
          <Check defaultChecked label="Closed all day" name="closed" />
          <div>
            <Button type="submit">Add special hours</Button>
          </div>
        </form>
        {specialHours?.length ? (
          <div className="mt-6 grid gap-4">
            {specialHours.map((special) => (
              <form
                action={updateSpecialHours}
                className="grid gap-3 rounded-xl border border-wayne-border p-4 md:grid-cols-2"
                key={special.id}
              >
                <input name="id" type="hidden" value={special.id} />
                <Input
                  defaultValue={special.service_date}
                  label="Date"
                  name="service_date"
                  required
                  type="date"
                />
                <Input
                  defaultValue={special.label}
                  label="Label"
                  name="label"
                />
                <Input
                  defaultValue={special.opens_at ?? ""}
                  label="Opens"
                  name="opens_at"
                  type="time"
                />
                <Input
                  defaultValue={special.closes_at ?? ""}
                  label="Closes"
                  name="closes_at"
                  type="time"
                />
                <Input
                  className="md:col-span-2"
                  defaultValue={special.public_note}
                  label="Public note"
                  name="public_note"
                />
                <Check
                  defaultChecked={special.closed}
                  label="Closed all day"
                  name="closed"
                />
                <div className="flex flex-wrap gap-2 md:justify-end">
                  <Button type="submit">Save override</Button>
                  <Button
                    formAction={archiveSpecialHours}
                    type="submit"
                    variant="secondary"
                  >
                    Archive
                  </Button>
                </div>
              </form>
            ))}
          </div>
        ) : null}
      </Card>
    </main>
  );
}

function SettingsSection({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <Card className="grid gap-5 p-6">
      <h2 className="text-2xl font-black">{title}</h2>
      {children}
    </Card>
  );
}
function TextArea({
  defaultValue,
  label,
  name,
  required = false,
  rows = 4,
}: {
  defaultValue: string;
  label: string;
  name: string;
  required?: boolean;
  rows?: number;
}) {
  return (
    <label className="grid gap-2 text-sm font-semibold">
      {label}
      <textarea
        className="rounded-lg border border-wayne-border bg-white px-3 py-2 font-normal shadow-inner"
        defaultValue={defaultValue}
        name={name}
        required={required}
        rows={rows}
      />
    </label>
  );
}
function Check({
  defaultChecked = false,
  label,
  name,
}: {
  defaultChecked?: boolean;
  label: string;
  name: string;
}) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
      <input
        className="h-5 w-5 accent-wayne-red"
        defaultChecked={defaultChecked}
        name={name}
        type="checkbox"
      />
      {label}
    </label>
  );
}
function Notice({
  children,
  kind,
}: {
  children: React.ReactNode;
  kind: "success" | "error";
}) {
  return (
    <div
      className={`mt-5 rounded-xl border p-4 font-semibold ${kind === "success" ? "border-green-200 bg-green-50 text-green-900" : "border-red-200 bg-red-50 text-red-900"}`}
    >
      {children}
    </div>
  );
}
function SeoFields({ settings }: { settings: StoreSettings }) {
  const fields = [
    ["Home", "seo_home_title", "seo_home_description"],
    ["Menu", "seo_menu_title", "seo_menu_description"],
    ["About", "seo_about_title", "seo_about_description"],
    ["Contact", "seo_contact_title", "seo_contact_description"],
  ] as const;
  return (
    <div className="grid gap-5">
      {fields.map(([label, title, description]) => (
        <div
          className="grid gap-3 rounded-xl border border-wayne-border p-4"
          key={label}
        >
          <Input
            defaultValue={String(settings[title])}
            label={`${label} page title`}
            name={title}
            required
          />
          <TextArea
            defaultValue={String(settings[description])}
            label={`${label} meta description`}
            name={description}
            rows={3}
          />
        </div>
      ))}
    </div>
  );
}
