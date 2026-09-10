import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { dailySalesSchema, itemReportSchema, reportSummarySchema } from "./schemas";

export async function getReportData(from: string, through: string) {
  const supabase = await createServerSupabaseClient();
  const args = { from_date: from, through_date: through };
  const [summaryResult, dailyResult, itemsResult] = await Promise.all([
    supabase.rpc("wayne_report_summary", args), supabase.rpc("wayne_report_daily_sales", args), supabase.rpc("wayne_report_items", args),
  ]);
  for (const result of [summaryResult, dailyResult, itemsResult]) if (result.error) throw new Error(`Report query failed: ${result.error.message}`);
  return { summary: reportSummarySchema.parse(summaryResult.data), daily: dailySalesSchema.array().parse(dailyResult.data), items: itemReportSchema.array().parse(itemsResult.data) };
}
