import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Record that a ticket was sent, or cleared on purpose by the register holding it. */
export const dynamic = "force-dynamic";

const closeSchema = z.object({ device_id: z.string().min(8).max(80), outcome: z.enum(["submitted", "discarded"]) });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Unknown ticket." }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Send JSON." }, { status: 400 }); }
  const parsed = closeSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_close_draft", { target_id: id, device: parsed.data.device_id, outcome: parsed.data.outcome });
  if (error) return Response.json({ error: "The ticket could not be closed." }, { status: 400 });
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
