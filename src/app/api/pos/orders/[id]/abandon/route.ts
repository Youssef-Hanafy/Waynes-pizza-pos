import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * The cashier left the payment screen without a payment or Pay later (owner,
 * 2026-10-19: "unless you press pay later or one of those buttons it doesn't
 * submit the order").  The database cancels it only if nothing was paid or
 * printed for it yet; otherwise it stays as an unpaid order.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const orderId = z.uuid().safeParse((await params).id);
  if (!orderId.success) return Response.json({ error: "Invalid order." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_abandon_order", { target_order_id: orderId.data });
  if (error) {
    logger.warn("pos.abandon_failed", { order_id: orderId.data, code: error.code });
    return Response.json({ error: "The order could not be closed out." }, { status: 400 });
  }
  const result = z.object({ cancelled: z.boolean() }).safeParse(data);
  return Response.json({ cancelled: result.success && result.data.cancelled }, { headers: { "Cache-Control": "no-store" } });
}
