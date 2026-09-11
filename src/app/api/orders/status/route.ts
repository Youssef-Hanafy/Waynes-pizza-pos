import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { orderTransitionSchema, transitionErrorMessage } from "@/lib/orders/status";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Counter, kitchen, and driver hand-off: out for delivery, completed, or cancelled. */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "orders.manage") && !hasPermission(access, "orders.cancel"))
    return Response.json({ error: "Order management access required. Sign in again if your session expired." }, { status: 403 });
  // Cookie-authenticated mutations are limited to this site's origin.
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = orderTransitionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid order action." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_transition_order", {
    target_order_id: parsed.data.order_id,
    expected_status: parsed.data.expected_status,
    next_status: parsed.data.next_status,
    reason: parsed.data.reason ?? null,
  });
  if (error) {
    logger.warn("order.transition_failed", { order_id: parsed.data.order_id, next_status: parsed.data.next_status, code: error.code });
    return Response.json({ error: transitionErrorMessage(error) }, { status: error.code === "40001" ? 409 : error.code === "42501" ? 403 : 400 });
  }
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
