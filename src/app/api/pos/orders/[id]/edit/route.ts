import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { spokenDatabaseMessage } from "@/lib/errors/database";
import { logger } from "@/lib/logging/logger";
import { posEditItemsInputSchema, posItemsAddedSchema } from "@/lib/pos/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Edit an order's items (owner, 2026-10-24): take lines off, change quantities,
 * replace a line with an edited copy, add new ones — all on the same order.
 * The database prices everything like a new order and prints no new slip.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const { id } = await params;
  const orderId = z.uuid().safeParse(id);
  const parsed = posEditItemsInputSchema.safeParse(await request.json().catch(() => null));
  if (!orderId.success) return Response.json({ error: "Order not found." }, { status: 404 });
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the items." }, { status: 400 });

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_edit_items", { target_order_id: orderId.data, payload: parsed.data });
  if (error) {
    logger.warn("pos.edit_items_failed", { order_id: orderId.data, code: error.code });
    return Response.json({ error: spokenDatabaseMessage(error, "The order could not be changed. Check it and try again.") }, { status: error.code === "42501" ? 403 : error.code === "P0002" ? 404 : error.code === "40001" ? 409 : 400 });
  }
  const result = posItemsAddedSchema.safeParse(data);
  if (!result.success) return Response.json({ error: "The changes were sent but could not be confirmed. Check Today's Orders before changing it again." }, { status: 500 });
  return Response.json(result.data, { status: result.data.duplicate ? 200 : 201, headers: { "Cache-Control": "no-store" } });
}
