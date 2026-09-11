import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { getDriverBoard } from "@/lib/delivery/queries";
import { deliveryErrorMessage, driverActionSchema } from "@/lib/delivery/schemas";
import { logger } from "@/lib/logging/logger";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET() {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "driver.access")) return Response.json({ error: "Driver access required. Sign in again if your session expired." }, { status: 403 });
  try { return Response.json(await getDriverBoard(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { logger.error("driver.load_failed", error); return Response.json({ error: "Deliveries are unavailable. Retrying connection…" }, { status: 503 }); }
}

export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "driver.access")) return Response.json({ error: "Driver access required." }, { status: 403 });
  // Cookie-authenticated mutations are limited to this site's origin.
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = driverActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid delivery action." }, { status: 400 });

  const supabase = await createServerSupabaseClient();
  const { order_id, action, cash_collected_cents, note } = parsed.data;
  const { error } = action === "claim"
    ? await supabase.rpc("wayne_driver_claim_delivery", { target_order_id: order_id })
    : await supabase.rpc("wayne_driver_update_delivery", {
      target_order_id: order_id, action,
      cash_cents: action === "delivered" ? cash_collected_cents ?? null : null,
      note: action === "delivered" ? note ?? "" : null,
    });

  if (error) {
    logger.warn("driver.action_failed", { order_id, action, code: error.code });
    return Response.json({ error: deliveryErrorMessage(error) }, { status: error.code === "40001" ? 409 : 400 });
  }
  return Response.json({ saved: true }, { headers: { "Cache-Control": "no-store" } });
}
