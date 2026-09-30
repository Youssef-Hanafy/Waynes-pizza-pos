import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getWorkspaceOnboarding } from "@/lib/tenancy/queries";
import { saveBusinessSetup } from "./actions";

export const metadata: Metadata = { title: "Business setup", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function WorkspaceOnboardingPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<{ error?: string; saved?: string }> }) {
  const [{ workspaceSlug }, notice] = await Promise.all([params, searchParams]);
  const workspace = await getWorkspaceOnboarding(workspaceSlug);
  if (!workspace || !workspace.location) notFound();

  return <main className="mx-auto max-w-4xl px-5 py-10">
    <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Business setup</p>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-4xl font-black">Welcome to {workspace.name}</h1><p className="mt-2 text-wayne-muted">Set up the core identity for your private restaurant workspace. Only your business can view or change these details.</p></div><Badge className={workspace.onboardingStatus === "ready" ? "bg-wayne-ok-soft text-wayne-ok" : "bg-wayne-warn-soft text-wayne-ink"}>{workspace.onboardingStatus.replaceAll("_", " ")}</Badge></div>
    {notice.saved ? <p className="mt-5 rounded-xl bg-wayne-ok-soft p-4 font-bold text-wayne-ok" role="status">{notice.saved}</p> : null}
    {notice.error ? <p className="mt-5 rounded-xl bg-wayne-alert-soft p-4 font-bold text-wayne-alert" role="alert">{notice.error}</p> : null}

    <Card className="mt-7 p-5"><h2 className="text-xl font-black">Business and first location</h2><p className="mt-2 text-sm text-wayne-muted">These values become the starting point for the storefront, receipts, taxes, service hours, and payment setup as each operational module is enabled.</p>
      <form action={saveBusinessSetup} className="mt-5 grid gap-4 md:grid-cols-2"><input name="workspace_id" type="hidden" value={workspace.id} /><input name="workspace_slug" type="hidden" value={workspace.slug} /><input name="location_id" type="hidden" value={workspace.location.id} />
        <Input defaultValue={workspace.name} label="Business name" maxLength={160} name="business_name" required />
        <Input defaultValue={workspace.legalName} label="Legal business name" maxLength={240} name="legal_name" />
        <Input defaultValue={workspace.publicEmail} label="Business email" maxLength={254} name="public_email" type="email" />
        <Input defaultValue={workspace.publicPhone} label="Business phone" maxLength={40} name="public_phone" type="tel" />
        <Input defaultValue={workspace.location.name} label="Location name" maxLength={160} name="location_name" required />
        <Input defaultValue={workspace.location.timezone} hint="IANA value, e.g. America/New_York" label="Time zone" maxLength={120} name="timezone" required />
        <Input className="md:col-span-2" defaultValue={workspace.location.addressLine1} label="Street address" maxLength={200} name="address_line1" />
        <Input className="md:col-span-2" defaultValue={workspace.location.addressLine2} label="Suite, unit, etc." maxLength={200} name="address_line2" />
        <Input defaultValue={workspace.location.city} label="City" maxLength={120} name="city" />
        <Input defaultValue={workspace.location.stateOrRegion} label="State / region" maxLength={120} name="state_or_region" />
        <Input defaultValue={workspace.location.postalCode} label="Postal code" maxLength={32} name="postal_code" />
        <Input defaultValue={workspace.location.countryCode} hint="Two-letter code, e.g. US" label="Country" maxLength={2} name="country_code" required />
        <label className="md:col-span-2 flex items-start gap-3 rounded-xl border border-wayne-border bg-wayne-cream p-4 text-sm"><input className="mt-1" defaultChecked={workspace.onboardingStatus === "ready"} name="complete" type="checkbox" /><span><strong className="block">Mark this business profile complete</strong><span className="mt-1 block text-wayne-muted">You can return and change these details later. Menu, payments, and operations will appear in this private workspace as they are enabled.</span></span></label>
        <Button className="md:col-span-2">Save business setup</Button>
      </form>
    </Card>

    <h2 className="mt-9 text-2xl font-black">Enabled for your business</h2><div className="mt-4 grid gap-3 sm:grid-cols-2">{workspace.services.map((service) => <Card className="p-4" key={service.code}><strong>{service.name}</strong><p className="mt-1 text-sm capitalize text-wayne-muted">{service.status}</p></Card>)}{!workspace.services.length ? <Card className="p-4 text-wayne-muted">No services are enabled yet. Contact Hanafy support.</Card> : null}</div>
  </main>;
}
