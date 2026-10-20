import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { deliveryDayReportSchema } from "@/lib/delivery/day-report";
import { logger } from "@/lib/logging/logger";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * A day's deliveries per driver (GET ?day=YYYY-MM-DD, default today): the
 * delivery close out slip and the driver's tips receipt (owner, 2026-10-19).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access") || !(hasPermission(access, "cash.manage") || hasPermission(access, "delivery.dispatch") || hasPermission(access, "reports.view"))) {
    return Response.json({ error: "Only a manager can see the delivery close out." }, { status: 403 });
  }
  const day = new URL(request.url).searchParams.get("day");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_delivery_day_report", { target_day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null });
  if (error) {
    logger.error("pos.delivery_day_report_failed", new Error(error.message), { code: error.code });
    return Response.json({ error: "The delivery close out is unavailable. Try again." }, { status: 503 });
  }
  const parsed = deliveryDayReportSchema.safeParse(data);
  if (!parsed.success) return Response.json({ error: "The delivery close out could not be read." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}
