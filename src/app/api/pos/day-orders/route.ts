import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { dayOrdersSchema } from "@/lib/orders/day-orders";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** POS → Today's orders: every order of a day (?day=YYYY-MM-DD, default today). */
export async function GET(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  const day = new URL(request.url).searchParams.get("day");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_day_orders", { target_day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null });
  if (error) {
    logger.error("pos.day_orders_failed", new Error(error.message), { code: error.code });
    return Response.json({ error: "Today's orders are unavailable. Retrying…" }, { status: 503 });
  }
  const parsed = dayOrdersSchema.safeParse(data);
  if (!parsed.success) return Response.json({ error: "Today's orders could not be read." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}
