import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { getKitchenBoard } from "@/lib/kitchen/queries";
import { kitchenTransitionSchema } from "@/lib/kitchen/schemas";
import { logger } from "@/lib/logging/logger";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET() {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "kitchen.access")) return Response.json({ error: "Kitchen access required. Sign in again if your session expired." }, { status: 403 });
  try { return Response.json(await getKitchenBoard(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { logger.error("kitchen.load_failed", error); return Response.json({ error: "Kitchen is unavailable. Retrying connection…" }, { status: 503 }); }
}

export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "kitchen.access")) return Response.json({ error: "Kitchen access required." }, { status: 403 });
  // Cookie-authenticated mutations are limited to this site's origin.
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = kitchenTransitionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid kitchen action." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_kitchen_transition", {
    target_order_id: parsed.data.order_id, expected_status: parsed.data.expected_status, next_status: parsed.data.next_status,
  });
  if (error) {
    logger.warn("kitchen.transition_failed", { order_id: parsed.data.order_id, code: error.code });
    return Response.json({ error: error.code === "40001" ? "Another screen changed this order. Refresh and try again." : "Action could not be saved. Refresh to check the order before retrying." }, { status: error.code === "40001" ? 409 : 400 });
  }
  return Response.json({ saved: true }, { headers: { "Cache-Control": "no-store" } });
}
