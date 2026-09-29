import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { printDocumentSchema } from "@/lib/printing/document";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Everything a receipt or kitchen ticket needs for one order (§23). No layout, no printer protocol. */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access") && !hasPermission(access, "printing.manage")) return Response.json({ error: "POS access required." }, { status: 403 });
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "Unknown order." }, { status: 404 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_print_document", { target_order_id: id });
  if (error) return Response.json({ error: "The order could not be loaded for printing." }, { status: 503 });
  if (data === null) return Response.json({ error: "Unknown order." }, { status: 404 });
  const parsed = printDocumentSchema.safeParse(data);
  if (!parsed.success) return Response.json({ error: "The order could not be read for printing." }, { status: 500 });
  return Response.json(parsed.data, { headers: { "Cache-Control": "no-store" } });
}
