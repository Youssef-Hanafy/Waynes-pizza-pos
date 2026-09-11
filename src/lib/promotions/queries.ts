import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { promotionSchema } from "./schemas";

export async function getPromotions(archived: boolean) {
  const supabase = await createServerSupabaseClient();
  let query = supabase.from("promotions").select("*").order("created_at", { ascending: false }).limit(200);
  query = archived ? query.not("archived_at", "is", null) : query.is("archived_at", null);
  const { data, error } = await query;
  if (error) throw new Error(`Promotions failed: ${error.message}`);
  return { promotions: promotionSchema.array().parse(data ?? []), readAt: Date.now() };
}
