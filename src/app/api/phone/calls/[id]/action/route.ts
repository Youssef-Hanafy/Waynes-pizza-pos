import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { callActionResultSchema, callActionSchema } from "@/lib/phone/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Claim, release, start an order from, dismiss, expire or reopen one call
 * (§22, §32, §34).  The claim is the lock that stops two registers taking the
 * same caller's order; a refused claim comes back with who holds it.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Unknown call." }, { status: 404 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Send JSON." }, { status: 400 });
  }
  const parsed = callActionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid action." }, { status: 400 });

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_phone_call_action", {
    target_call_id: id, action: parsed.data.action, terminal: parsed.data.terminal, force: parsed.data.force,
  });
  if (error) {
    if (error.code === "P0002") return Response.json({ error: "That call was not found." }, { status: 404 });
    return Response.json({ error: "The phone line could not be updated." }, { status: error.code === "42501" ? 403 : 400 });
  }
  const result = callActionResultSchema.safeParse(data);
  if (!result.success) return Response.json({ error: "The call update was invalid." }, { status: 500 });
  return Response.json(result.data, { headers: { "Cache-Control": "no-store" } });
}
