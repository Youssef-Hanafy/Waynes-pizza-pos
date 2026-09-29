import type { Metadata } from "next";
import Link from "next/link";
import { provisionWorkspace } from "../../actions";
import { Flash, first, serviceName } from "@/components/platform/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { weekDays } from "@/lib/platform/provisioning";
import { requirePlatformUser } from "@/lib/platform/queries";
import { serviceCodes } from "@/lib/tenancy/services";

export const metadata: Metadata = { title: "Add business" };
export const dynamic = "force-dynamic";

const select = "min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal";
const requirementNotes: Partial<Record<string, string>> = { sms: "needs CRM", email: "needs CRM", automations: "needs CRM", caller_id: "needs POS", delivery: "needs POS or online ordering" };

/**
 * Add Business (§25 steps 1-3).  Creates the business in "provisioning" with
 * only the services picked; the setup checklist (steps 4-10) follows.
 */
export default async function AddBusinessPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePlatformUser({ manage: true, nextPath: "/platform/workspaces/new" });
  const query = await searchParams;
  const zones = Intl.supportedValuesOf("timeZone").filter((zone) => zone.startsWith("America/") || zone.startsWith("Pacific/Honolulu") || zone === "UTC");

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <Link className="text-sm font-bold text-wayne-muted hover:underline" href="/platform/workspaces">← Businesses</Link>
      <h1 className="mt-3 text-4xl font-black">Add a business</h1>
      <p className="mt-2 max-w-3xl text-wayne-muted">
        The business starts in <strong>provisioning</strong>: nothing is live, no texts go out, and its website doesn&apos;t answer until you activate it
        from the setup checklist. Only the services you pick are switched on.
      </p>
      <Flash error={first(query.error)} saved={first(query.saved)} />

      <form action={provisionWorkspace} className="mt-6 grid gap-6">
        <Card className="p-6">
          <h2 className="text-2xl font-black">1. Business</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <Input label="Business name" maxLength={120} name="name" placeholder="Joe's Deli" required />
            <Input hint="Lowercase letters, numbers and dashes. Used in links; can't be changed later." label="Web name (slug)" maxLength={60} name="slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="joes-deli" required />
            <Input label="Legal name" maxLength={240} name="legal_name" placeholder="Joe's Deli LLC" />
            <label className="grid gap-1.5 text-sm font-bold">Type of business
              <select className={select} defaultValue="restaurant" name="industry"><option value="restaurant">Restaurant</option><option value="retail">Retail</option><option value="services">Services</option><option value="other">Other</option></select>
            </label>
            <label className="grid gap-1.5 text-sm font-bold">Time zone
              <select className={select} defaultValue="America/New_York" name="timezone">{zones.map((zone) => <option key={zone} value={zone}>{zone.replace("_", " ")}</option>)}</select>
            </label>
            <Input defaultValue="USD" label="Currency" maxLength={3} name="currency_code" />
            <Input label="Primary contact" maxLength={120} name="contact_name" placeholder="Owner's name" />
            <Input label="Contact email" name="contact_email" type="email" />
            <Input label="Contact phone" maxLength={40} name="contact_phone" />
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-2xl font-black">2. First location</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <Input label="Location name" maxLength={120} name="location_name" placeholder="Main Street" required />
            <Input className="md:col-span-2" label="Street address" maxLength={200} name="address_line_1" />
            <Input label="Address line 2" maxLength={200} name="address_line_2" />
            <Input label="City" maxLength={120} name="city" />
            <div className="grid grid-cols-2 gap-3"><Input label="State" maxLength={60} name="state_region" /><Input label="ZIP" maxLength={20} name="postal_code" /></div>
            <Input label="Public phone" maxLength={40} name="location_phone" />
            <Input label="Public email" name="location_email" type="email" />
            <label className="grid gap-1.5 text-sm font-bold">Location time zone
              <select className={select} defaultValue="" name="location_timezone"><option value="">Same as the business</option>{zones.map((zone) => <option key={zone} value={zone}>{zone.replace("_", " ")}</option>)}</select>
            </label>
            <Input defaultValue="11:00" label="Opens" name="opens" type="time" />
            <Input defaultValue="21:00" label="Closes" name="closes" type="time" />
            <fieldset className="text-sm md:col-span-3"><legend className="font-bold">Closed on</legend>
              <div className="mt-2 flex flex-wrap gap-4">{weekDays.map((day) => <label className="flex items-center gap-1.5 capitalize" key={day}><input name="closed_days" type="checkbox" value={day} />{day}</label>)}</div>
              <p className="mt-1 text-wayne-muted">Hours can be fine-tuned per day later in the business&apos;s Website & hours screen.</p>
            </fieldset>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-2xl font-black">3. Services</h2>
          <p className="mt-1 text-sm text-wayne-muted">Only what is picked here is switched on. Staff screens, permissions and the website follow these.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {serviceCodes.map((code) => (
              <label className="flex items-start gap-2 rounded-xl border border-wayne-border p-3" key={code}>
                <input className="mt-1" name="services" type="checkbox" value={code} />
                <span><strong>{serviceName(code)}</strong>{requirementNotes[code] ? <span className="block text-xs text-wayne-muted">{requirementNotes[code]}</span> : null}</span>
              </label>
            ))}
          </div>
          <label className="mt-4 grid max-w-xs gap-1.5 text-sm font-bold">Why they have these services
            <select className={select} defaultValue="manual" name="service_source"><option value="manual">Set by Hanafy</option><option value="custom_contract">Custom contract</option><option value="plan">Standard plan</option></select>
          </label>
        </Card>

        <Card className="p-6">
          <h2 className="text-2xl font-black">Create</h2>
          <div className="mt-4 grid gap-3">
            <label className="flex items-start gap-2 font-bold"><input className="mt-1" defaultChecked name="is_test" type="checkbox" value="yes" />This is a temporary test workspace (not a real client)</label>
            <label className="flex items-start gap-2 text-sm"><input className="mt-1" name="real_client_confirmed" type="checkbox" value="yes" />For a real client (test box unticked): I confirm this client&apos;s workspace was authorized.</label>
            <Input className="max-w-xl" label="Reason" minLength={5} name="reason" placeholder="Developer test workspace / Signed agreement with Joe" required />
            <div><Button size="lg" variant="brand">Create business</Button></div>
          </div>
        </Card>
      </form>
    </main>
  );
}
