import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { maxTipCents, posCashoutRequestSchema, posCashoutResultSchema, posDeliveryBoardSchema } from "@/lib/delivery/pos-board";
import { spokenDatabaseMessage } from "@/lib/errors/database";
import { logger } from "@/lib/logging/logger";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { PaymentProviderError } from "@/lib/payments/provider";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server";

type Capture = { order_id: string; payment_id: string; captured_cents: number; tip_cents: number; card_brand: string | null; card_last4: string | null };

/**
 * Cash a driver out (owner, 2026-10-11).
 *
 * 1. Every card held for one of the driver's deliveries is charged on Stripe —
 *    once — for the order total plus the tip typed in (never more than the
 *    hold), and the rest of the hold is released.
 * 2. wayne_pos_driver_cashout records the cash orders, the tips, the drawer
 *    payout and the cash-out itself.
 *
 * A held card that can't be charged (expired, network) is left out of this
 * cash-out and stays on the driver's list, so nothing is recorded as paid
 * that wasn't.  Retrying is safe: each capture uses a fixed idempotency key.
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
  const captures: Capture[] = [];
  const skipped: string[] = [];
  const problems: string[] = [];

  if (held.length) {
    const resolved = await resolvePaymentProvider("online", { workspaceId: access.workspace_id, locationId: access.location_id ?? null });
    const service = createServiceSupabaseClient();
    const { data: payments } = await service.from("payments")
      .select("id, order_id, provider_payment_id, card_brand, card_last4")
      .in("order_id", held.map((order) => order.order_id)).eq("provider", "stripe").eq("status", "authorized")
      .eq("workspace_id", access.workspace_id);

    for (const order of held) {
      const payment = payments?.find((candidate) => candidate.order_id === order.order_id);
      const tip = Math.min(Math.max(0, tipFor.get(order.order_id) ?? 0), maxTipCents(order));
      const amount = order.total_cents + tip;
      if (!resolved.ok || !payment?.provider_payment_id) {
        skipped.push(order.order_id);
        problems.push(`Order ${order.order_number}: the held card could not be reached${resolved.ok ? "" : " (Stripe isn't set up)"}. It stays on the list.`);
        continue;
      }
      try {
        const result = await resolved.value.provider.capturePayment(payment.provider_payment_id, {
          amountCents: amount, idempotencyKey: `driver-cashout-${payment.id}-${amount}`,
        });
        if (result.status !== "captured") throw new PaymentProviderError("The card was not charged.", "NOT_CAPTURED");
        const captured = result.amountCents ?? amount;
        captures.push({
          order_id: order.order_id, payment_id: payment.id, captured_cents: captured, tip_cents: Math.max(0, captured - order.total_cents),
          card_brand: result.cardBrand ?? payment.card_brand ?? null, card_last4: result.cardLast4 ?? payment.card_last4 ?? null,
        });
      } catch (cause) {
        // Already charged by an earlier try that didn't finish? Then use what Stripe says.
        try {
          const status = await resolved.value.provider.getPaymentStatus(payment.provider_payment_id);
          if (status.status === "captured" && status.amountCents) {
            captures.push({
              order_id: order.order_id, payment_id: payment.id, captured_cents: status.amountCents,
              tip_cents: Math.max(0, status.amountCents - order.total_cents), card_brand: status.cardBrand ?? payment.card_brand ?? null,
              card_last4: status.cardLast4 ?? payment.card_last4 ?? null,
            });
            continue;
          }
        } catch { /* fall through to the problem below */ }
        logger.error("pos.driver_cashout_capture_failed", cause, { order_id: order.order_id });
        skipped.push(order.order_id);
        problems.push(`Order ${order.order_number}: ${cause instanceof Error ? cause.message : "the held card could not be charged"}. It stays on the list — take cash for it or try again.`);
      }
    }
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
  const result = posCashoutResultSchema.safeParse(data);
  if (!result.success) return Response.json({ error: "The cash-out was saved but could not be read back. Refresh Deliveries." }, { status: 500 });
  return Response.json({ ...result.data, problems }, { headers: { "Cache-Control": "no-store" } });
}
