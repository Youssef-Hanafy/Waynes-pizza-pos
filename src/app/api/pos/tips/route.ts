import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { spokenDatabaseMessage } from "@/lib/errors/database";
import { logger } from "@/lib/logging/logger";
import { captureHeldCards } from "@/lib/payments/tip-capture";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server";
import { heldCardSchema, tipCaptureRequestSchema } from "@/lib/tips/schemas";

/**
 * POS → Tips (owner, 2026-10-13).  GET: every card approved and still held
 * for the tip on its signed slip.  POST: the tips off the slips — each card
 * is captured once on Stripe for order + tip, then the orders are updated.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_tip_queue");
  if (error) {
    logger.error("pos.tip_queue_failed", new Error(error.message), { code: error.code });
    return Response.json({ error: "The cards waiting for tips could not be loaded." }, { status: 503 });
  }
  const parsed = z.array(heldCardSchema).safeParse(data);
  if (!parsed.success) return Response.json({ error: "The cards waiting for tips could not be read." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!access?.workspace_id || !hasPermission(access, "pos.access") || !(hasPermission(access, "cash.manage") || hasPermission(access, "delivery.dispatch"))) {
    return Response.json({ error: "Only a manager can add tips to cards." }, { status: 403 });
  }
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = tipCaptureRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the tips and try again." }, { status: 400 });

  const result = await captureHeldCards({
    service: createServiceSupabaseClient(), workspaceId: access.workspace_id, locationId: access.location_id ?? null,
    requests: parsed.data.tips, keyPrefix: "tips",
  });
  if (!result.captures.length) return Response.json({ error: result.problems.join(" ") || "No card could be charged.", problems: result.problems }, { status: 502 });

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_apply_card_tips", { captures: result.captures, via: "pos_tips" });
  if (error) {
    logger.error("pos.tip_apply_failed", error, { captured: result.captures.length });
    return Response.json({
      error: `${spokenDatabaseMessage(error, "The tips could not be saved.")} The cards were already charged — press Charge again to finish saving (nobody is charged twice).`,
      problems: result.problems,
    }, { status: 400 });
  }
  const saved = z.object({ count: z.number().int(), tips_cents: z.number().int() }).safeParse(data);
  return Response.json({ charged: saved.success ? saved.data.count : result.captures.length, tips_cents: saved.success ? saved.data.tips_cents : 0, problems: result.problems }, { headers: { "Cache-Control": "no-store" } });
}
