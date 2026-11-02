import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { spokenDatabaseMessage } from "@/lib/errors/database";
import { changeFulfillmentSchema, fulfillmentChangedSchema } from "@/lib/orders/fulfillment";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const id = z.uuid().safeParse((await params).id);
  const input = changeFulfillmentSchema.safeParse(await request.json().catch(() => null));
  if (!id.success || !input.success) return Response.json({ error: input.success ? "Order not found." : input.error.issues[0]?.message ?? "Check the order details." }, { status: 400 });
  const client = await createServerSupabaseClient();
  const { data, error } = await client.rpc("wayne_pos_change_fulfillment", { target_order_id: id.data, payload: input.data });
  if (error) return Response.json({ error: spokenDatabaseMessage(error, "The order type could not be saved.") }, { status: error.code === "42501" ? 403 : error.code === "40001" ? 409 : 400 });
  const result = fulfillmentChangedSchema.safeParse(data);
  if (!result.success) return Response.json({ error: "The change could not be confirmed. Reopen the order to check its type." }, { status: 500 });
  return Response.json(result.data, { headers: { "Cache-Control": "no-store" } });
}
