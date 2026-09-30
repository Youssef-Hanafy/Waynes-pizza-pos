import "server-only";

import { createServerSupabaseClient } from "@/lib/supabase/server";

export type PlatformWorkspaceSummary = {
  id: string;
  slug: string;
  name: string;
  status: "draft" | "active" | "suspended" | "archived";
  onboardingStatus: "not_started" | "in_progress" | "ready";
  locationCount: number;
  activeMemberCount: number;
};

export type WorkspaceOnboarding = {
  id: string;
  slug: string;
  name: string;
  legalName: string;
  publicEmail: string;
  publicPhone: string;
  onboardingStatus: "not_started" | "in_progress" | "ready";
  location: {
    id: string;
    name: string;
    timezone: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    stateOrRegion: string;
    postalCode: string;
    countryCode: string;
  } | null;
  services: Array<{ code: string; name: string; status: "trial" | "active" | "paused" | "cancelled" }>;
};

export type AvailableService = { code: string; name: string; description: string };

/** Safe DTOs only; database RLS is the authorization boundary for these reads. */
export async function getPlatformWorkspaceSummaries(): Promise<PlatformWorkspaceSummary[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, slug, name, status, onboarding_status, locations(id), workspace_members(user_id, active)")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Platform workspace list failed: ${error.message}`);

  return (data ?? []).map((workspace) => ({
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    status: workspace.status as PlatformWorkspaceSummary["status"],
    onboardingStatus: workspace.onboarding_status as PlatformWorkspaceSummary["onboardingStatus"],
    locationCount: workspace.locations?.length ?? 0,
    activeMemberCount: workspace.workspace_members?.filter((member) => member.active).length ?? 0
  }));
}

export async function getAvailableServices(): Promise<AvailableService[]> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.from("service_catalog").select("code, name, description").eq("active", true).order("name");
  if (error) throw new Error(`Service catalog failed: ${error.message}`);
  return data ?? [];
}

export async function getWorkspaceOnboarding(slug: string): Promise<WorkspaceOnboarding | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, slug, name, legal_name, public_email, public_phone, onboarding_status, locations(id, name, timezone, address_line1, address_line2, city, state_or_region, postal_code, country_code), workspace_services(status, service_catalog(code, name))")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`Business onboarding failed: ${error.message}`);
  if (!data) return null;

  const location = data.locations?.[0] ?? null;
  return {
    id: data.id,
    slug: data.slug,
    name: data.name,
    legalName: data.legal_name,
    publicEmail: data.public_email,
    publicPhone: data.public_phone,
    onboardingStatus: data.onboarding_status as WorkspaceOnboarding["onboardingStatus"],
    location: location ? {
      id: location.id,
      name: location.name,
      timezone: location.timezone,
      addressLine1: location.address_line1,
      addressLine2: location.address_line2,
      city: location.city,
      stateOrRegion: location.state_or_region,
      postalCode: location.postal_code,
      countryCode: location.country_code
    } : null,
    services: (data.workspace_services ?? []).flatMap((entry) => (entry.service_catalog ?? []).map((service) => ({
      code: service.code,
      name: service.name,
      status: entry.status as WorkspaceOnboarding["services"][number]["status"]
    })))
  };
}
