import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { posOrderLinesSchema } from "@/lib/pos/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** An order's items, for editing it on the POS (owner, 2026-10-24). */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Order not found." }, { status: 404 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_order_lines", { target_order_id: id });
  if (error) return Response.json({ error: error.code === "P0002" ? "Order not found." : "The order's items could not be loaded." }, { status: error.code === "P0002" ? 404 : 503 });
  const parsed = posOrderLinesSchema.safeParse(data);
  if (!parsed.success) return Response.json({ error: "The order's items could not be read." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}
