import type { Metadata } from "next";
import { z } from "zod";
import { saveDomain, saveStorefront } from "../../../actions";
import { Flash, first, when } from "@/components/platform/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { storefrontFields } from "@/lib/platform/domains";
import { getPlatformWorkspace, getPlatformWorkspaceDomains } from "@/lib/platform/queries";

export const metadata: Metadata = { title: "Domains & website" };
export const dynamic = "force-dynamic";

const pendingSchema = z.object({
  confirm: z.enum(["deactivate", "remove"]),
  id: z.uuid(),
  reason: z.string().max(500),
  warnings: z.string().max(4000).transform((value, context) => {
    try {
      return z.array(z.string().max(400)).max(8).parse(JSON.parse(value));
    } catch {
      context.addIssue({ code: "custom", message: "bad warnings" });
      return z.NEVER;
    }
  }),
});

const long = new Set(["homepage_description", "story"]);

/**
 * Domains & website (§13).  Which web addresses answer for this business,
 * which one is the main (canonical) address, and the storefront basics the
 * public site shows.  An address only answers while the business and its
 * location are active; unknown addresses never fall back to another business.
 */
export default async function PlatformWorkspaceDomainsPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const [workspace, data] = await Promise.all([getPlatformWorkspace(workspaceSlug), getPlatformWorkspaceDomains(workspaceSlug)]);
  const tz = workspace.timezone;
  const pending = pendingSchema.safeParse(Object.fromEntries(["confirm", "id", "reason", "warnings"].map((key) => [key, first(query[key]) ?? ""])));
  const confirming = pending.success ? pending.data : null;
  const hidden = <input name="workspace" type="hidden" value={workspace.slug} />;
  const primary = typeof data.brand_colors.primary === "string" ? data.brand_colors.primary : "";
  const storefrontOn = data.services.includes("website_storefront") || data.services.includes("online_ordering");

  return (
    <div className="mt-6">
      {confirming ? (
        <Card className="mt-2 border-wayne-alert/50 p-5">
          <h2 className="text-xl font-black">Confirm the web address change</h2>
          <ul className="mt-3 list-disc space-y-1 pl-5">{confirming.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          <form action={saveDomain} className="mt-4 flex flex-wrap gap-3">
            {hidden}<input name="action" type="hidden" value={confirming.confirm} /><input name="id" type="hidden" value={confirming.id} />
            <input name="reason" type="hidden" value={confirming.reason} /><input name="confirmed" type="hidden" value="yes" />
            <Button variant="danger">Yes, switch it off</Button>
            <Button asChild variant="secondary"><a href={`/platform/workspaces/${workspace.slug}/domains`}>Cancel</a></Button>
          </form>
        </Card>
      ) : <Flash error={first(query.error)} saved={first(query.saved)} />}

      <h2 className="mt-2 text-2xl font-black">Web addresses</h2>
      <p className="mt-1 max-w-3xl text-sm text-wayne-muted">
        Each address answers for this business only{data.workspace_status === "active" ? "" : " — and only once the business is activated"}.
        The main address is used in links, search results and texts. To connect one, add it here, then point its DNS at the app&apos;s host (for Vercel: add the domain to the project).
        {storefrontOn ? "" : " This business has neither the website nor online ordering on, so addresses show a \"not found\" page."}
      </p>
      <div className="mt-3 grid gap-2">
        {data.domains.map((domain) => (
          <Card className="flex flex-wrap items-center justify-between gap-3 p-4" key={domain.id}>
            <div>
              <strong className="text-lg">{domain.hostname}</strong>
              <span className="ml-2 text-sm text-wayne-muted">{domain.location_name} · added {when(domain.created_at, tz)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {domain.is_canonical ? <Badge tone="brand">Main</Badge> : null}
              <Badge tone={domain.resolves ? "ok" : domain.active ? "warn" : "neutral"}>{domain.resolves ? "Answering" : domain.active ? "On (business not live)" : "Off"}</Badge>
              {data.can_manage && !confirming ? (
                <form action={saveDomain} className="flex flex-wrap items-center gap-2">
                  {hidden}<input name="id" type="hidden" value={domain.id} />
                  <input aria-label="Reason" className="min-h-9 w-44 rounded-lg border border-wayne-border px-2 text-sm" minLength={5} name="reason" placeholder="Reason" required />
                  <select aria-label="Action" className="min-h-9 rounded-lg border border-wayne-border px-2 text-sm" defaultValue={domain.is_canonical ? (domain.active ? "deactivate" : "activate") : "canonical"} name="action">
                    {domain.is_canonical ? null : <option value="canonical">Make main</option>}
                    {domain.active ? <option value="deactivate">Switch off</option> : <option value="activate">Switch on</option>}
                    {domain.active ? null : <option value="remove">Remove</option>}
                  </select>
                  <Button size="sm" variant="secondary">Apply</Button>
                </form>
              ) : null}
            </div>
          </Card>
        ))}
        {data.domains.length === 0 ? <Card className="p-5 text-wayne-muted">No web address yet.</Card> : null}
      </div>
      {data.can_manage && !confirming ? (
        <Card className="mt-3 p-5">
          <form action={saveDomain} className="grid gap-3 md:grid-cols-[1fr_14rem_auto_1fr_auto] md:items-end">
            {hidden}<input name="action" type="hidden" value="add" />
            <Input label="Add a web address" name="hostname" placeholder="orders.joesdeli.com" required />
            <label className="grid gap-1.5 text-sm font-bold">Location
              <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue={data.locations[0]?.id ?? ""} name="location_id">
                {data.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 pb-3 text-sm font-bold"><input name="is_canonical" type="checkbox" value="yes" />Main</label>
            <Input label="Reason" minLength={5} name="reason" required />
            <Button variant="brand">Add</Button>
          </form>
        </Card>
      ) : null}

      <h2 className="mt-10 text-2xl font-black">Website basics</h2>
      <p className="mt-1 max-w-3xl text-sm text-wayne-muted">
        What the public website shows for each location: name, headlines, search text, contact and brand colour.
        {data.legacy ? " This business also has the full Website & hours screen in its own admin." : " The business's full website editor comes with its operations move; these basics cover a new storefront."}
      </p>
      {data.locations.map((location) => {
        const value = (key: string) => (typeof location.storefront[key] === "string" ? (location.storefront[key] as string) : "");
        return (
          <Card className="mt-3 p-5" key={location.id}>
            <h3 className="text-lg font-black">{location.name}</h3>
            {data.can_manage ? (
              <form action={saveStorefront} className="mt-3 grid gap-4 md:grid-cols-2">
                {hidden}<input name="location_id" type="hidden" value={location.id} />
                {storefrontFields.map(([key, label, max]) => long.has(key) ? (
                  <label className="grid gap-1.5 text-sm font-bold md:col-span-2" key={key}>{label}
                    <textarea className="min-h-24 rounded-xl border border-wayne-border bg-white p-3 font-normal" defaultValue={value(key)} maxLength={max} name={key} />
                  </label>
                ) : <Input defaultValue={value(key)} key={key} label={label} maxLength={max} name={key} />)}
                <label className="grid gap-1.5 text-sm font-bold">Online ordering
                  <select className="min-h-11 rounded-xl border border-wayne-border bg-white px-3 font-normal" defaultValue={location.storefront.ordering_open === false ? "no" : "yes"} name="ordering_open"><option value="yes">Open</option><option value="no">Closed</option></select>
                </label>
                <Input defaultValue={primary} label="Brand colour (whole business)" name="brand_primary" pattern="#[0-9a-fA-F]{6}" placeholder="#b02222" />
                <Input label="Reason" minLength={5} name="reason" required />
                <div className="md:col-span-2"><Button variant="brand">Save website basics</Button></div>
              </form>
            ) : (
              <p className="mt-2 text-sm">{value("store_name") || "—"} · {value("homepage_heading") || "no headline"}</p>
            )}
          </Card>
        );
      })}
    </div>
  );
}
