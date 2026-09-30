import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requirePlatformAdmin } from "@/lib/tenancy/access";
import { getAvailableServices, getPlatformWorkspaceSummaries } from "@/lib/tenancy/queries";
import { createBusiness } from "./actions";

export const metadata: Metadata = { title: "Hanafy Platform", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function PlatformPage({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  await requirePlatformAdmin("/platform");
  const [params, workspaces, services] = await Promise.all([searchParams, getPlatformWorkspaceSummaries(), getAvailableServices()]);

  return <main className="mx-auto max-w-6xl px-5 py-10">
    <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-red">Hanafy platform</p>
    <h1 className="mt-3 text-4xl font-black">Businesses</h1>
    <p className="mt-3 max-w-3xl text-wayne-muted">Provision a private restaurant workspace, give its owner a separate sign-in, and let them set up their own business. Each workspace is isolated from every other restaurant.</p>
    {params.saved ? <p className="mt-5 rounded-xl bg-wayne-ok-soft p-4 font-bold text-wayne-ok" role="status">{params.saved}</p> : null}
    {params.error ? <p className="mt-5 rounded-xl bg-wayne-alert-soft p-4 font-bold text-wayne-alert" role="alert">{params.error}</p> : null}

    <Card className="mt-7 p-5"><h2 className="text-xl font-black">Add a business</h2><p className="mt-2 max-w-3xl text-sm text-wayne-muted">The owner receives an individual account—never share your Hanafy platform sign-in. Give them the temporary password privately, then direct them to their onboarding link.</p>
      <form action={createBusiness} className="mt-5 grid gap-4 md:grid-cols-2">
        <Input label="Business name" maxLength={160} name="business_name" placeholder="Mario's Pizza" required />
        <Input hint="Used in its onboarding link: /onboarding/marios-pizza" label="Business URL key" maxLength={80} name="workspace_slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="marios-pizza" required />
        <Input hint="Optional; shown on business paperwork." label="Legal business name" maxLength={240} name="legal_name" />
        <Input hint="Optional; customer-facing contact email." label="Business email" maxLength={254} name="public_email" type="email" />
        <Input label="Business phone" maxLength={40} name="public_phone" type="tel" />
        <Input label="First location name" maxLength={160} name="location_name" placeholder="Main Street" required />
        <label className="grid gap-1.5 text-sm font-bold">Time zone<select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3.5 font-normal" defaultValue="America/New_York" name="timezone"><option value="America/New_York">Eastern time</option><option value="America/Chicago">Central time</option><option value="America/Denver">Mountain time</option><option value="America/Los_Angeles">Pacific time</option></select></label>
        <div className="hidden md:block" />
        <Input autoComplete="off" label="Owner name" maxLength={120} name="owner_name" required />
        <Input autoComplete="off" label="Owner email / sign-in" name="owner_email" required type="email" />
        <Input autoComplete="new-password" className="md:col-span-2" hint="At least 12 characters with upper- and lowercase letters and a number. Share it privately." label="Owner temporary password" minLength={12} name="owner_password" required type="password" />
        <fieldset className="md:col-span-2"><legend className="text-sm font-bold">Enable services</legend><div className="mt-2 grid gap-3 sm:grid-cols-2">{services.map((service) => <label className="flex gap-3 rounded-xl border border-wayne-border bg-white p-3" key={service.code}><input className="mt-1" defaultChecked name="service_codes" type="checkbox" value={service.code} /><span><strong className="block text-sm">{service.name}</strong><span className="mt-0.5 block text-xs text-wayne-muted">{service.description}</span></span></label>)}</div></fieldset>
        <Button className="md:col-span-2">Create business workspace</Button>
      </form>
    </Card>

    <h2 className="mt-10 text-2xl font-black">Provisioned businesses</h2>
    <div className="mt-4 grid gap-4 md:grid-cols-2">{workspaces.map((workspace) => <Card className="p-5" key={workspace.id}><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-xl font-black">{workspace.name}</h3><p className="mt-1 text-sm text-wayne-muted">{workspace.slug} · {workspace.locationCount} location{workspace.locationCount === 1 ? "" : "s"} · {workspace.activeMemberCount} active member{workspace.activeMemberCount === 1 ? "" : "s"}</p></div><div className="flex gap-2"><Badge>{workspace.status}</Badge><Badge className={workspace.onboardingStatus === "ready" ? "bg-wayne-ok-soft text-wayne-ok" : "bg-wayne-warn-soft text-wayne-ink"}>{workspace.onboardingStatus.replaceAll("_", " ")}</Badge></div></div><Button asChild className="mt-5" variant="secondary"><Link href={`/onboarding/${workspace.slug}`}>Open onboarding</Link></Button></Card>)}{!workspaces.length ? <Card className="p-6 text-wayne-muted">Your first restaurant will appear here.</Card> : null}</div>
  </main>;
}
