import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { spokenDatabaseMessage } from "@/lib/errors/database";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const bodySchema = z.object({ tip_cents: z.number().int().min(0).max(100_000) });

/** Set the tip on an unpaid order before the card is run (customer screen or counter). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const { id } = await params;
  const orderId = z.uuid().safeParse(id);
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!orderId.success || !parsed.success) return Response.json({ error: "Invalid tip." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_set_tip", { target_order_id: orderId.data, tip_amount: parsed.data.tip_cents });
  if (error) return Response.json({ error: spokenDatabaseMessage(error, "The tip could not be added.") }, { status: 400 });
  const result = z.object({ tip_cents: z.number().int(), total_cents: z.number().int() }).safeParse(data);
  if (!result.success) return Response.json({ error: "The tip could not be confirmed." }, { status: 500 });
  return Response.json(result.data, { headers: { "Cache-Control": "no-store" } });
}
