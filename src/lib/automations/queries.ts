import "server-only";

import { logger } from "@/lib/logging/logger";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { automationDetailSchema, automationsOverviewSchema, type AutomationDetail, type AutomationsOverview } from "./schemas";

export async function getAutomationsOverview(workspaceSlug: string): Promise<AutomationsOverview> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_automations_overview", { target_workspace_slug: workspaceSlug });
  if (error) {
    logger.error("automations.overview_failed", new Error(error.message), { code: error.code ?? null });
    throw new Error("Automations could not be loaded.");
  }
  return automationsOverviewSchema.parse(data);
}

export async function getAutomationDetail(workspaceSlug: string, automationId: string): Promise<AutomationDetail | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("hanafy_automation_detail", { target_workspace_slug: workspaceSlug, target_automation_id: automationId });
  if (error) {
    if (error.code === "P0002") return null;
    logger.error("automations.detail_failed", new Error(error.message), { code: error.code ?? null });
    throw new Error("The automation could not be loaded.");
  }
  return automationDetailSchema.parse(data);
}
