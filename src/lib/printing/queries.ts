import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { printJobSchema } from "./schemas";

export async function getPrintQueue(printed: boolean) {
  const supabase = await createServerSupabaseClient();
  let query = supabase.from("print_jobs").select("*").order("created_at", { ascending: !printed }).limit(200);
  query = printed ? query.eq("status", "printed") : query.neq("status", "printed");
  const { data, error } = await query;
  const parsed = printJobSchema.array().safeParse(data);
  return { jobs: error || !parsed.success ? null : parsed.data, unavailable: Boolean(error) || !parsed.success, readAt: Date.now() };
}
