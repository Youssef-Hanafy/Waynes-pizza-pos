import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { cardReaderPaymentSchema } from "@/lib/pos/tender";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * A card payment run on a standalone reader (e.g. Boston North's) that isn't
 * linked to the POS yet: the cashier keyed the total into the reader, it was
 * approved, and this records it.  The database checks permission, refuses a
 * second payment, audits it and opens the cash drawer.
 */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });

  const parsed = cardReaderPaymentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid card payment." }, { status: 400 });

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("wayne_record_card_payment", { payload: parsed.data });
  if (error) {
    logger.warn("pos.card_reader_payment_failed", { code: error.code });
    const known = ["22023", "P0002", "40001", "42501"].includes(error.code ?? "");
    return Response.json({ error: known ? error.message : "The card payment could not be recorded." }, { status: error.code === "40001" ? 409 : 400 });
  }
  return Response.json({ saved: true, result: data }, { headers: { "Cache-Control": "no-store" } });
}
