import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { dailySalesSchema, itemReportSchema, reportOrderSchema, reportSummarySchema } from "./schemas";

export async function getReportData(from: string, through: string) {
  const supabase = await createServerSupabaseClient();
  const args = { from_date: from, through_date: through };
  const [summaryResult, dailyResult, itemsResult] = await Promise.all([
    supabase.rpc("wayne_report_summary", args), supabase.rpc("wayne_report_daily_sales", args), supabase.rpc("wayne_report_items", args),
  ]);
  for (const result of [summaryResult, dailyResult, itemsResult]) if (result.error) throw new Error(`Report query failed: ${result.error.message}`);
  return { summary: reportSummarySchema.parse(summaryResult.data), daily: dailySalesSchema.array().parse(dailyResult.data), items: itemReportSchema.array().parse(itemsResult.data) };
}

export async function getReportOrders(from: string, through: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_report_orders", { from_date: from, through_date: through });
  if (error) throw new Error(`Report order export failed: ${error.message}`);
  return reportOrderSchema.array().parse(data);
}
