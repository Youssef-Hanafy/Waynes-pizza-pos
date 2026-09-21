import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { posCallRecordedSchema, posCallReportSchema } from "@/lib/phone/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * A ring heard by a provider running on the register itself — the simulator
 * today, the Android caller ID listener later (§19: "optionally sync event to
 * Supabase afterward").  The card is already on screen; this records it,
 * deduplicates it, and returns the customers the number matches.
 *
 * Uses the cashier's own session, never the service role (§38).
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send JSON." }, { status: 400 });
  }
  const parsed = posCallReportSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid call." }, { status: 400 });

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_record_call", { payload: parsed.data });
  if (error) {
    logger.error("phone.pos_record_failed", new Error(error.message), { code: error.code });
    const message = error.message.includes("simulator is switched off") ? "The caller ID simulator is switched off in Admin → Hardware." : "The call could not be recorded.";
    return Response.json({ error: message }, { status: error.code === "42501" ? 403 : 400 });
  }
  const result = posCallRecordedSchema.safeParse(data);
  if (!result.success) return Response.json({ error: "The call record was invalid." }, { status: 500 });
  return Response.json(result.data, { status: result.data.duplicate ? 200 : 201, headers: { "Cache-Control": "no-store" } });
}
