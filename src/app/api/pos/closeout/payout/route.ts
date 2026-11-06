import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** Store close out queues the bank payout independently of printer availability. */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access") || !hasPermission(access, "cash.manage") || !access?.workspace_id || !access.location_id) return Response.json({ error: "Only a manager can queue the bank payout." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Choose a valid closeout date." }, { status: 400 });
  const service = await createServerSupabaseClient();
  const { data, error } = await service.rpc("wayne_queue_bank_payout", { target_workspace_id: access.workspace_id, target_location_id: access.location_id, target_day: parsed.data.day });
  if (error) return Response.json({ error: "The bank payout could not be queued. Try again; duplicate payments will not be added." }, { status: 503 });
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
