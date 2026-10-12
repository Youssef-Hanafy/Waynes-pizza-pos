import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { posDeliveryActionSchema, posDeliveryBoardSchema } from "@/lib/delivery/pos-board";
import { spokenDatabaseMessage } from "@/lib/errors/database";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** The POS Deliveries tab: orders waiting to go out and each driver's run. */
export async function GET() {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "delivery.dispatch")) return Response.json({ error: "Delivery dispatch permission required." }, { status: 403 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_delivery_board");
  if (error) return Response.json({ error: "Deliveries could not be loaded." }, { status: 400 });
  const parsed = posDeliveryBoardSchema.safeParse(data);
  if (!parsed.success) return Response.json({ error: "Deliveries were invalid." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}

/** Send an order out with a driver, or take it back. */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "delivery.dispatch")) return Response.json({ error: "Delivery dispatch permission required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = posDeliveryActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message === "Wrong PIN." ? "Wrong PIN." : "Invalid delivery action." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  if (parsed.data.action === "send_out_pin") {
    const { data, error } = await supabase.rpc("wayne_pos_send_out_with_pin", { target_order_ids: parsed.data.order_ids, pin_value: parsed.data.pin });
    if (error) return Response.json({ error: spokenDatabaseMessage(error, "That could not be saved. Refresh and try again.") }, { status: error.code === "42501" ? 403 : 400 });
    const result = (data ?? {}) as { ok?: boolean; error?: string; name?: string; count?: number };
    if (!result.ok) return Response.json({ error: result.error ?? "Wrong PIN." }, { status: 400 });
    return Response.json({ saved: true, name: result.name ?? "", count: result.count ?? 0 }, { headers: { "Cache-Control": "no-store" } });
  }
  const { error } = parsed.data.action === "send_out"
    ? await supabase.rpc("wayne_pos_send_out", { target_order_id: parsed.data.order_id, target_driver_id: parsed.data.driver_id })
    : await supabase.rpc("wayne_pos_unassign", { target_order_id: parsed.data.order_id });
  if (error) return Response.json({ error: spokenDatabaseMessage(error, "That could not be saved. Refresh and try again.") }, { status: error.code === "42501" ? 403 : 400 });
  return Response.json({ saved: true }, { headers: { "Cache-Control": "no-store" } });
}
