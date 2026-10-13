import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { dayCloseoutSchema, saveCloseoutSchema } from "@/lib/closeout/schemas";
import { logger } from "@/lib/logging/logger";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * POS → Close Out: the day's sales, payments by card brand, online orders on
 * their own, and the cash count (GET ?day=YYYY-MM-DD, default today).  POST
 * counts the cash, closes the open drawer and keeps the close out on file.
 */
export const dynamic = "force-dynamic";

function allowed(access: Awaited<ReturnType<typeof getCurrentAccess>>) {
  return hasPermission(access, "pos.access") && (hasPermission(access, "cash.manage") || hasPermission(access, "reports.view"));
}

export async function GET(request: Request) {
  const access = await getCurrentAccess();
  if (!allowed(access)) return Response.json({ error: "Only a manager can see the close out." }, { status: 403 });
  const day = new URL(request.url).searchParams.get("day");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_day_closeout", { target_day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null });
  if (error) {
    logger.error("pos.closeout_failed", new Error(error.message), { code: error.code });
    const missing = error.code === "PGRST202" || error.code === "42883";
    return Response.json({ error: missing ? "The close out isn't set up in the database yet (migration 20261030090000_day_closeout)." : "The close out is unavailable. Try again." }, { status: 503 });
  }
  const parsed = dayCloseoutSchema.safeParse(data);
  if (!parsed.success) return Response.json({ error: "The close out could not be read." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access") || !hasPermission(access, "cash.manage")) return Response.json({ error: "Only a manager can close out the day." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = saveCloseoutSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Check the count." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_save_day_closeout", { payload: parsed.data });
  if (error) {
    logger.warn("pos.closeout_save_failed", { code: error.code });
    // The database's own words are written for the cashier (e.g. "explain the difference").
    const message = ["22023", "P0001", "40001", "42501"].includes(error.code ?? "") ? error.message : "The close out could not be saved. Try again.";
    return Response.json({ error: message }, { status: error.code === "42501" ? 403 : 400 });
  }
  return Response.json({ saved: true, closeout: data }, { headers: { "Cache-Control": "no-store" } });
}
