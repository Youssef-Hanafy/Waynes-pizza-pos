import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { cardDayBatchResultSchema } from "@/lib/closeout/card-batch";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** Explicit credit-card day batch action; independent of cash closeout and printing. */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access") || !hasPermission(access, "cash.manage") || !access?.workspace_id || !access.location_id) return Response.json({ error: "Only a manager can queue the bank payout." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Choose a valid closeout date." }, { status: 400 });
  const service = await createServerSupabaseClient();
  const { data, error } = await service.rpc("wayne_close_card_day_batch", { target_workspace_id: access.workspace_id, target_location_id: access.location_id, target_day: parsed.data.day });
  if (error) return Response.json({ error: "The bank payout could not be queued. Try again; duplicate payments will not be added." }, { status: 503 });
  const result = cardDayBatchResultSchema.safeParse(data);
  if (!result.success) return Response.json({ error: "The batch confirmation could not be read. Retry to check the saved batch; payments will not be duplicated." }, { status: 503 });
  return Response.json(result.data, { headers: { "Cache-Control": "no-store" } });
}
