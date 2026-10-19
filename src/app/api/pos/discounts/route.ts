import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { posDiscountSchema } from "@/lib/pos/discounts";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** POS → Discount button: the discounts saved in Admin → Discounts. */
export async function GET() {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_discounts");
  if (error) {
    logger.warn("pos.discounts_failed", { code: error.code });
    return Response.json({ error: "Saved discounts are unavailable." }, { status: 503 });
  }
  const parsed = posDiscountSchema.array().safeParse(data);
  if (!parsed.success) return Response.json({ error: "Saved discounts could not be read." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}
