import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Move a ticket from another register to this one (§36). Audited in the database. */
export const dynamic = "force-dynamic";

const takeSchema = z.object({ device_id: z.string().min(8).max(80), terminal: z.string().max(60).default("") });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Unknown ticket." }, { status: 404 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Send JSON." }, { status: 400 }); }
  const parsed = takeSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "A register id is required." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_take_draft", { target_id: id, device: parsed.data.device_id, terminal: parsed.data.terminal });
  if (error) return Response.json({ error: error.code === "P0002" ? "That ticket was not found." : "That ticket could not be moved here." }, { status: error.code === "P0002" ? 404 : 400 });
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
