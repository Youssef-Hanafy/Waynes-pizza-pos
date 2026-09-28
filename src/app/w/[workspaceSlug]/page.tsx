import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireWorkspaceContext } from "@/lib/tenancy/context";
import { isServiceCode, serviceCodes, serviceLabels } from "@/lib/tenancy/services";
import { businessDate, zonedLocalToUtcIso } from "@/lib/time/zoned";

export const metadata: Metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

function formatCents(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * Workspace overview.  Every figure is read through RLS with an explicit
 * workspace filter, so it can only ever show this business's rows.
 */
export default async function WorkspaceOverviewPage({ params, searchParams }: { params: Promise<{ workspaceSlug: string }>; searchParams: Promise<{ unavailable?: string }> }) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const context = await requireWorkspaceContext({ workspaceSlug }).catch(() => notFound());
  const supabase = await createServerSupabaseClient();
  const workspaceId = context.workspace.id;
  const timezone = context.workspace.timezone;
  const today = businessDate(timezone);
  const dayStart = zonedLocalToUtcIso(`${today}T00:00`, timezone) ?? new Date().toISOString();
  const canSeeOrders = context.permissions.includes("orders.view");

  const [locations, orders] = await Promise.all([
    supabase.from("locations").select("id, name, status, city, state_region").eq("workspace_id", workspaceId).order("created_at"),
    canSeeOrders
      ? supabase.from("orders").select("total_cents, status").eq("workspace_id", workspaceId).gte("created_at", dayStart).limit(5000)
      : Promise.resolve({ data: null, error: null }),
  ]);
  const todaysOrders = (orders.data ?? []) as Array<{ total_cents: number; status: string }>;
  const counted = todaysOrders.filter((order) => order.status !== "cancelled");
  const sales = counted.reduce((sum, order) => sum + (order.total_cents ?? 0), 0);
  const unavailable = query.unavailable && isServiceCode(query.unavailable) ? query.unavailable : null;

  return (
    <main className="mx-auto max-w-7xl px-5 py-10">
      {unavailable ? (
        <p className="mb-6 rounded-xl border border-wayne-warn/40 bg-wayne-warn-soft p-4 font-bold" role="alert">
          {serviceLabels[unavailable]} is not enabled for {context.workspace.name}. Contact Hanafy Media to turn it on.
        </p>
      ) : null}
      <p className="text-sm font-black uppercase tracking-[0.2em] text-wayne-muted">Overview · {today}</p>
      <h1 className="mt-3 text-4xl font-black">{context.workspace.name}</h1>

      {canSeeOrders ? (
        <div className="mt-7 grid gap-4 sm:grid-cols-2">
          <Card className="p-5"><p className="text-sm text-wayne-muted">Orders today</p><strong className="mt-1 block text-4xl">{counted.length}</strong></Card>
          <Card className="p-5"><p className="text-sm text-wayne-muted">Sales today (before refunds)</p><strong className="mt-1 block text-4xl">{formatCents(sales)}</strong></Card>
        </div>
      ) : null}

      <h2 className="mt-10 text-2xl font-black">Services</h2>
      <div className="mt-4 flex flex-wrap gap-2">
        {serviceCodes.map((code) => (
          <Badge key={code} tone={context.enabled_services.includes(code) ? "ok" : "neutral"}>
            {serviceLabels[code]} · {context.enabled_services.includes(code) ? "on" : "off"}
          </Badge>
        ))}
      </div>

      <h2 className="mt-10 text-2xl font-black">Locations</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {((locations.data ?? []) as Array<{ id: string; name: string; status: string; city: string; state_region: string }>).map((location) => (
          <Card className="p-5" key={location.id}>
            <strong className="block text-lg">{location.name}</strong>
            <span className="text-sm text-wayne-muted">{[location.city, location.state_region].filter(Boolean).join(", ")}{location.status === "active" ? "" : ` · ${location.status}`}</span>
          </Card>
        ))}
      </div>
      {context.legacy_operations ? null : (
        <p className="mt-10 max-w-3xl text-sm text-wayne-muted">
          The register, kitchen and back-office screens are being moved onto the shared platform one module at a time.
          Modules for this business appear in the menu above as they become available.
        </p>
      )}
    </main>
  );
}
