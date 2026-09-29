import "server-only";

import { logger } from "@/lib/logging/logger";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { audienceSchema, marketingOverviewSchema, type MarketingOverview } from "./schemas";

/** Campaign Manager data for the signed-in user's workspace (the database checks the permission). */
export async function getMarketingOverview(workspaceSlug: string): Promise<MarketingOverview> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_marketing_overview", { target_workspace_slug: workspaceSlug });
  if (error) {
    logger.error("marketing.overview_failed", new Error(error.message), { code: error.code ?? null });
    throw new Error("Marketing could not be loaded.");
  }
  return marketingOverviewSchema.parse(data);
}

export async function getCampaignAudience(workspaceSlug: string, campaignId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_campaign_audience", { target_workspace_slug: workspaceSlug, target_campaign_id: campaignId });
  if (error) return null;
  const parsed = audienceSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/** The business's own clock, for showing and scheduling times. */
export async function workspaceTimezone(slug: string) {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.from("workspaces").select("timezone").eq("slug", slug).maybeSingle();
  return typeof data?.timezone === "string" ? data.timezone : "UTC";
}
