import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { openOrderSchema } from "@/lib/orders/status";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET() {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access") || !hasPermission(access, "orders.manage"))
    return Response.json({ error: "POS order access required." }, { status: 403 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_open_orders");
  if (error) {
    logger.error("pos.open_orders_failed", new Error(error.message), { code: error.code });
    return Response.json({ error: "Open orders are unavailable. Retrying…" }, { status: 503 });
  }
  const parsed = z.array(openOrderSchema).safeParse(data);
  if (!parsed.success) return Response.json({ error: "Open orders could not be read." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}
