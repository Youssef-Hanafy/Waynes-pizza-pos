import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { posCustomerOrderSchema } from "@/lib/pos/schemas";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** A customer's recent orders for the POS customer and phone screens (§8, §14). */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Unknown customer." }, { status: 404 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_customer_orders", { target_customer_id: id });
  if (error) return Response.json({ error: "Order history could not be read." }, { status: 503 });
  const parsed = posCustomerOrderSchema.array().safeParse(data);
  if (!parsed.success) return Response.json({ error: "Order history was invalid." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}
