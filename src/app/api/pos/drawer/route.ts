import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { cashErrorMessage, drawerActionSchema } from "@/lib/cash/schemas";
import { getPosDrawer } from "@/lib/cash/queries";
import { logger } from "@/lib/logging/logger";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/**
 * The cash drawer, from the counter's side: open it with a counted float, take cash
 * on an order, record a paid-in or paid-out with a reason, and close it against a
 * count. Every one of these is permission-checked and audited in the database; this
 * route only carries the request.
 */
export async function GET() {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  try {
    return Response.json(await getPosDrawer(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    logger.error("drawer.load_failed", error);
    return Response.json({ error: "The drawer is unavailable. Retrying…" }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access")) return Response.json({ error: "POS access required." }, { status: 403 });
  // Cookie-authenticated mutations are limited to this site's origin.
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });

  const parsed = drawerActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid drawer action." }, { status: 400 });

  const supabase = await createServerSupabaseClient();
  const input = parsed.data;
  const call = async () => {
    switch (input.action) {
      case "open":
        return supabase.rpc("wayne_open_shift", {
          payload: { register_id: input.register_id, opening_cash_cents: input.opening_cash_cents },
        });
      case "movement":
        return supabase.rpc("wayne_record_cash_movement", {
          payload: { shift_id: input.shift_id, kind: input.kind, amount_cents: input.amount_cents, reason: input.reason },
        });
      case "close":
        return supabase.rpc("wayne_close_shift", {
          payload: { shift_id: input.shift_id, counted_cash_cents: input.counted_cash_cents, close_note: input.close_note },
        });
      case "cash_payment":
        return supabase.rpc("wayne_take_cash_payment", {
          payload: {
            shift_id: input.shift_id, order_id: input.order_id,
            tendered_cents: input.tendered_cents, idempotency_key: input.idempotency_key,
          },
        });
    }
  };

  const { data, error } = await call();
  if (error) {
    logger.warn("drawer.action_failed", { action: input.action, code: error.code });
    return Response.json({ error: cashErrorMessage(error) }, { status: error.code === "40001" ? 409 : 400 });
  }
  return Response.json({ saved: true, result: data }, { headers: { "Cache-Control": "no-store" } });
}
