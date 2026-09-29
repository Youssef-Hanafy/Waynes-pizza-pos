import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { z } from "zod";
import { promotionSchema } from "./schemas";

const statsSchema = z.array(z.object({
  promotion_id: z.uuid(), codes_issued: z.number().int(), orders_count: z.number().int(),
  revenue_cents: z.coerce.number(), discount_cents: z.coerce.number(),
}));
export type PromotionStats = z.infer<typeof statsSchema>[number];

export async function getPromotions(archived: boolean) {
  const supabase = await createServerSupabaseClient();
  // Each customer's personal code lives under its offer, not in this list.
  let query = supabase.from("promotions").select("*").is("parent_promotion_id", null).order("created_at", { ascending: false }).limit(200);
  query = archived ? query.not("archived_at", "is", null) : query.is("archived_at", null);
  const { data, error } = await query;
  if (error) throw new Error(`Promotions failed: ${error.message}`);
  return { promotions: promotionSchema.array().parse(data ?? []), readAt: Date.now() };
}

/** Codes sent, orders placed with them, and the money those orders brought in. */
export async function getPromotionStats(): Promise<Map<string, PromotionStats>> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_promotion_stats");
  if (error) throw new Error(`Promotion numbers failed: ${error.message}`);
  return new Map(statsSchema.parse(data ?? []).map((row) => [row.promotion_id, row]));
}
