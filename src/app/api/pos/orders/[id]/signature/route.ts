import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const bodySchema = z.object({ signature_svg: z.string().min(20).max(200_000), tip_cents: z.number().int().min(0).max(100_000).default(0) });

/** Keep the customer's signature with the order (signed on the customer screen). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const { id } = await params;
  const orderId = z.uuid().safeParse(id);
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!orderId.success || !parsed.success || !parsed.data.signature_svg.trimStart().startsWith("<svg")) return Response.json({ error: "Invalid signature." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("wayne_pos_save_signature", { target_order_id: orderId.data, svg: parsed.data.signature_svg, tip_amount: parsed.data.tip_cents });
  if (error) return Response.json({ error: "The signature could not be saved." }, { status: 400 });
  return Response.json({ saved: true }, { headers: { "Cache-Control": "no-store" } });
}
