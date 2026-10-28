import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { posCashoutRequestSchema, posCashoutResultSchema, posDeliveryBoardSchema } from "@/lib/delivery/pos-board";
import { spokenDatabaseMessage } from "@/lib/errors/database";
import { logger } from "@/lib/logging/logger";
import { captureHeldCards, type TipCapture } from "@/lib/payments/tip-capture";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server";

/**
 * Cash a driver out (owner, 2026-10-11).
 *
 * 1. Every delivery card (keyed in over the phone, authorised for the order)
 *    is captured on Stripe — once — for the order total plus the tip written on
 *    the slip.  This is the restaurant "tip adjust": one charge, one card fee.
 *    Stripe says per card how far it can be captured (overcapture); a tip
 *    above that is left off the card and reported.
 * 2. wayne_pos_driver_cashout records the cash orders, the tips, the drawer
 *    payout and the cash-out itself.
 *
 * Test orders' cards were never real: they are "captured" here without Stripe.
 * A card that can't be charged (expired, network) is left out of this cash-out
 * and stays on the driver's list, so nothing is recorded as paid that wasn't.
 * Retrying is safe: each capture uses a fixed idempotency key.
 */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!access?.workspace_id || !(hasPermission(access, "cash.manage") || hasPermission(access, "delivery.dispatch"))) {
    return Response.json({ error: "Cash management permission required." }, { status: 403 });
  }
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = posCashoutRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Check the tips and try again." }, { status: 400 });

  const supabase = await createServerSupabaseClient();
  const { data: boardData, error: boardError } = await supabase.rpc("wayne_pos_delivery_board");
  const board = posDeliveryBoardSchema.safeParse(boardData);
  if (boardError || !board.success) return Response.json({ error: "Deliveries could not be loaded." }, { status: 400 });
  const driver = board.data.drivers.find((candidate) => candidate.driver_id === parsed.data.driver_id);
  if (!driver || !driver.orders.length) return Response.json({ error: "This driver has no deliveries to cash out." }, { status: 400 });

  const tipFor = new Map(parsed.data.tips.map((tip) => [tip.order_id, tip.tip_cents]));
  const held = driver.orders.filter((order) => order.paid_by === "card_held");
  let captures: TipCapture[] = [];
  let skipped: string[] = [];
  let problems: string[] = [];

  if (held.length) {
    // One capture per held card, order + the tip on the slip (shared with POS → Tips).
    const result = await captureHeldCards({
      service: createServiceSupabaseClient(), workspaceId: access.workspace_id, locationId: access.location_id ?? null,
      requests: held.map((order) => ({ order_id: order.order_id, tip_cents: Math.max(0, tipFor.get(order.order_id) ?? 0) })),
      keyPrefix: "driver-cashout",
    });
    ({ captures, skipped, problems } = result);
  }

  if (skipped.length === driver.orders.length) {
    return Response.json({ error: problems.join(" ") || "Nothing could be cashed out.", problems }, { status: 502 });
  }

  const { data, error } = await supabase.rpc("wayne_pos_driver_cashout", {
    target_driver_id: parsed.data.driver_id,
    tips: parsed.data.tips,
    card_captures: captures,
    skip_orders: skipped,
    cashout_note: parsed.data.note,
  });
  if (error) {
    logger.error("pos.driver_cashout_failed", error, { driver_id: parsed.data.driver_id, captured: captures.length });
    return Response.json({
      error: captures.length
        ? `${spokenDatabaseMessage(error, "The cash-out could not be saved.")} The held cards were already charged — press Cash out again to finish (they won't be charged twice).`
        : spokenDatabaseMessage(error, "The cash-out could not be saved."),
      problems,
    }, { status: 400 });
  }
  // The tips typed for the orders just cashed out are done (best effort: only orders still waiting are ever shown).
  const cashedOut = driver.orders.map((order) => order.order_id).filter((id) => !skipped.includes(id));
  await supabase.rpc("wayne_pos_clear_tip_drafts", { order_ids: cashedOut }).then(() => undefined, () => undefined);
  const result = posCashoutResultSchema.safeParse(data);
  if (!result.success) return Response.json({ error: "The cash-out was saved but could not be read back. Refresh Deliveries." }, { status: 500 });
  return Response.json({ ...result.data, problems, cashed_out_order_ids: cashedOut }, { headers: { "Cache-Control": "no-store" } });
}
