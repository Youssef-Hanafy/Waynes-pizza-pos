import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { posDraftSchema } from "@/lib/orders/drafts";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Tickets in progress, shared between registers (build sheet Phase 6). */
export const dynamic = "force-dynamic";

const syncInputSchema = z.object({
  id: z.uuid(),
  idempotency_key: z.string().min(16).max(160),
  device_id: z.string().min(8).max(80),
  terminal: z.string().max(60),
  status: z.enum(["open", "held"]),
  label: z.string().max(120),
  item_count: z.number().int().min(0).max(200),
  phone_line: z.number().int().min(1).max(8).nullable(),
  phone_call_id: z.union([z.literal(""), z.uuid()]),
  // The ticket body is validated as a real ticket before it is stored.
  payload: posDraftSchema.omit({ syncedVersion: true, syncedAt: true, submitPending: true }),
});

export async function GET() {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_open_drafts");
  if (error) return Response.json({ error: "Tickets on other registers could not be read." }, { status: 503 });
  return Response.json(data ?? [], { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Send JSON." }, { status: 400 }); }
  const parsed = syncInputSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid ticket." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_sync_draft", { payload: parsed.data });
  if (error) return Response.json({ error: "The ticket could not be saved to the server." }, { status: error.code === "42501" ? 403 : 400 });
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
