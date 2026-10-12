import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * Print the kitchen ticket now (owner, 2026-10-12): a counter / phone order's
 * ticket waits for the payment step so it says PAID or NOT PAID correctly.
 * Paying releases it by itself; this is for Pay later / Cash at the door.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const orderId = z.uuid().safeParse((await params).id);
  if (!orderId.success) return Response.json({ error: "Invalid order." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_release_print", { target_order_id: orderId.data });
  if (error) return Response.json({ error: "The kitchen ticket could not be released." }, { status: 400 });
  return Response.json({ released: data === true }, { headers: { "Cache-Control": "no-store" } });
}
