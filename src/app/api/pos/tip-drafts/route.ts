import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { serverTipDraftSchema, tipDraftSaveRequestSchema } from "@/lib/tips/drafts";

/**
 * The tips typed from the slips, saved as they are typed (owner, 2026-10-28).
 * GET: what is saved for orders still waiting for their tip.  POST: save
 * (newest value wins; an older copy never replaces a newer one).  Saving never
 * charges anything — POS → Tips "Charge" and Deliveries "Cash out" do that.
 */
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403, headers: noStore });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_tip_drafts");
  if (error) {
    logger.error("pos.tip_drafts_read_failed", new Error(error.message), { code: error.code });
    return Response.json({ error: "The saved tips could not be loaded." }, { status: 503, headers: noStore });
  }
  const parsed = z.array(serverTipDraftSchema).safeParse(data);
  if (!parsed.success) return Response.json({ error: "The saved tips could not be read." }, { status: 500, headers: noStore });
  return Response.json(parsed.data, { headers: noStore });
}

export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403, headers: noStore });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403, headers: noStore });
  const parsed = tipDraftSaveRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the tip amounts (e.g. 5.00)." }, { status: 400, headers: noStore });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_save_tip_drafts", { drafts: parsed.data.drafts });
  if (error) {
    logger.error("pos.tip_drafts_save_failed", new Error(error.message), { code: error.code, count: parsed.data.drafts.length });
    // 503 = try again later (kept on the register); 400 = the value itself was refused.
    return Response.json({ error: error.code === "22023" ? error.message : "The tips could not be saved to the server." }, { status: error.code === "22023" ? 400 : error.code === "42501" ? 403 : 503, headers: noStore });
  }
  const rows = z.array(serverTipDraftSchema).safeParse(data);
  if (!rows.success) return Response.json({ error: "The tips were saved but could not be read back." }, { status: 500, headers: noStore });
  return Response.json(rows.data, { headers: noStore });
}
