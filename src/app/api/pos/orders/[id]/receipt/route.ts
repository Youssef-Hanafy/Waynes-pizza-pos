import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * "Print receipt" from any register: queue the customer receipt for the front
 * printer.  The print station prints it (the register asking doesn't need to
 * reach the printer itself).  Asking twice before it prints prints one copy.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access") && !hasPermission(access, "printing.manage")) return Response.json({ error: "POS access required." }, { status: 403 });
  // Cookie-authenticated mutations are limited to this site's origin.
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Unknown order." }, { status: 404 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_request_receipt_print", { target_order_id: id });
  if (error) return Response.json({ error: error.code === "P0002" ? "Unknown order." : "The receipt could not be sent to the printer." }, { status: error.code === "P0002" ? 404 : 503 });
  const parsed = z.object({ ok: z.boolean(), status: z.enum(["queued", "already_queued"]) }).safeParse(data);
  if (!parsed.success) return Response.json({ error: "The receipt could not be sent to the printer." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}
