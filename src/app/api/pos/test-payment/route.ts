import { z } from "zod";
import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  order_id: z.uuid(),
  /** Card reader (the drawer opens) or a card keyed in over the phone. */
  entry: z.enum(["card_reader", "test_keyed"]),
  /** A delivery card is only approved; it is "charged" with the tip at the driver's cash-out. */
  authorize_only: z.boolean().default(false),
  idempotency_key: z.string().min(16).max(160),
});

/**
 * A simulated card payment on a TEST order (owner, 2026-10-11): every card
 * screen works the same as for a real order, but no card is ever charged.
 * The database refuses this for any order that isn't a test.
 */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid test payment." }, { status: 400 });
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_pos_test_card_payment", {
    target_order_id: parsed.data.order_id, authorize_only: parsed.data.authorize_only,
    entry: parsed.data.entry, request_key: parsed.data.idempotency_key,
  });
  if (error) {
    const known = ["22023", "P0002", "40001", "42501"].includes(error.code ?? "");
    return Response.json({ error: known ? error.message : "The test payment could not be recorded." }, { status: error.code === "40001" ? 409 : 400 });
  }
  const result = data as { status?: string } | null;
  return Response.json({ payment_status: result?.status === "authorized" ? "authorized" : "captured" }, { headers: { "Cache-Control": "no-store" } });
}
