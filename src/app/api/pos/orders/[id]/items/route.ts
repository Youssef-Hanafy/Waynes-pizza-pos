import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { spokenDatabaseMessage } from "@/lib/errors/database";
import { logger } from "@/lib/logging/logger";
import { posAddItemsInputSchema, posItemsAddedSchema } from "@/lib/pos/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Add items to an order already sent (owner, 2026-10-13: "edit orders so you
 * can add items if the customer wants to add something extra").  The database
 * prices the lines exactly like a new order; an unpaid order gets them on the
 * same ticket, a paid one gets an add-on that is paid on its own.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const { id } = await params;
  const orderId = z.uuid().safeParse(id);
  const parsed = posAddItemsInputSchema.safeParse(await request.json().catch(() => null));
  if (!orderId.success) return Response.json({ error: "Order not found." }, { status: 404 });
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the items." }, { status: 400 });

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_add_items", { target_order_id: orderId.data, payload: parsed.data });
  if (error) {
    logger.warn("pos.add_items_failed", { order_id: orderId.data, code: error.code });
    return Response.json({ error: spokenDatabaseMessage(error, "The items could not be added. Check the order and try again.") }, { status: error.code === "42501" ? 403 : error.code === "P0002" ? 404 : 400 });
  }
  const result = posItemsAddedSchema.safeParse(data);
  if (!result.success) return Response.json({ error: "The items were sent but could not be confirmed. Check Today's Orders before adding them again." }, { status: 500 });
  return Response.json(result.data, { status: result.data.duplicate ? 200 : 201, headers: { "Cache-Control": "no-store" } });
}
