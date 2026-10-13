import "server-only";

import { logger } from "@/lib/logging/logger";
import type { createServiceSupabaseClient } from "@/lib/supabase/server";
import { resolvePaymentProvider } from "./config";
import { PaymentProviderError } from "./provider";

/**
 * Tip adjust (owner, 2026-10-13): every card is authorised for the order and
 * captured ONCE, later, for order + the tip written on the signed slip — the
 * way restaurants do it.  Stripe "overcapture" lets the capture be larger
 * than the authorisation (up to 50% or $50 more, whichever is greater, on
 * Visa / Mastercard / Discover / Amex; Stripe says per card).
 *
 * Used by POS → Tips (the night's slips), Deliveries → cash-out (drivers) and
 * the 4:30 am safety net (anything still waiting, no added tip).
 *
 * This only talks to Stripe.  Recording the result is the caller's job
 * (wayne_pos_apply_card_tips / wayne_pos_driver_cashout), with what's returned.
 * Each capture has a fixed idempotency key, and a card already captured by an
 * earlier try that didn't finish is read back from Stripe, so retrying never
 * charges twice.
 */

type Service = ReturnType<typeof createServiceSupabaseClient>;

export type TipRequest = { order_id: string; tip_cents: number };

export type TipCapture = {
  order_id: string;
  payment_id: string;
  /** What the card was captured for in total. */
  captured_cents: number;
  /** Tip added by this capture (on top of anything already in the authorised amount). */
  tip_cents: number;
  card_brand: string | null;
  card_last4: string | null;
};

export type TipCaptureResult = {
  captures: TipCapture[];
  /** Orders whose card could not be captured — they stay waiting. */
  skipped: string[];
  /** What went wrong or was cut down, in words for the cashier. */
  problems: string[];
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Room for a tip on a held card: Stripe's limit when known, else 50% or $50 — whichever is greater. */
export function tipRoomCents(authorizedCents: number, maxCaptureCents: number | null | undefined) {
  const max = typeof maxCaptureCents === "number" && maxCaptureCents > 0 ? maxCaptureCents : authorizedCents + Math.max(Math.round(authorizedCents / 2), 5000);
  return Math.max(0, max - authorizedCents);
}

export async function captureHeldCards(options: {
  service: Service;
  workspaceId: string;
  locationId: string | null;
  requests: TipRequest[];
  /** Part of each capture's idempotency key ("tips", "driver-cashout", "auto"). */
  keyPrefix: string;
}): Promise<TipCaptureResult> {
  const { service, workspaceId, requests } = options;
  const result: TipCaptureResult = { captures: [], skipped: [], problems: [] };
  if (!requests.length) return result;

  const { data: rows, error } = await service.from("payments")
    .select("id, order_id, provider, provider_payment_id, amount_cents, card_brand, card_last4, metadata, order:orders!inner(order_number, workspace_id)")
    .in("order_id", requests.map((request) => request.order_id))
    .eq("status", "authorized").eq("method", "card").in("provider", ["stripe", "test"])
    .eq("orders.workspace_id", workspaceId);
  if (error) throw new PaymentProviderError("The held cards could not be loaded.", "DATABASE", true);

  let resolved: Awaited<ReturnType<typeof resolvePaymentProvider>> | null = null;
  const stripe = async () => (resolved ??= await resolvePaymentProvider("online", { workspaceId, locationId: options.locationId }));

  for (const request of requests) {
    const payment = rows?.find((row) => row.order_id === request.order_id);
    const orderNumber = (payment?.order as unknown as { order_number?: string } | null)?.order_number ?? "";
    if (!payment) { result.skipped.push(request.order_id); result.problems.push("A card is no longer waiting for a tip (already charged or cancelled)."); continue; }
    const label = `Order ${orderNumber || payment.order_id.slice(0, 8)}`;
    const wanted = Math.max(0, Math.round(request.tip_cents || 0));
    const metadata = (payment.metadata ?? {}) as Record<string, unknown>;
    const authorized = payment.amount_cents as number;

    // A test order's card was simulated: "capture" it without Stripe.
    if (payment.provider === "test") {
      const tip = Math.min(wanted, tipRoomCents(authorized, metadata.max_capture_cents as number | undefined));
      if (wanted > tip) result.problems.push(`${label}: only ${money(tip)} of the ${money(wanted)} tip fits on this card (test).`);
      result.captures.push({ order_id: payment.order_id, payment_id: payment.id, captured_cents: authorized + tip, tip_cents: tip, card_brand: payment.card_brand ?? "test", card_last4: payment.card_last4 ?? "4242" });
      continue;
    }

    const provider = await stripe();
    if (!provider.ok || !payment.provider_payment_id) {
      result.skipped.push(payment.order_id);
      result.problems.push(`${label}: the card could not be reached${provider.ok ? "" : " (Stripe isn't set up)"}. It stays waiting.`);
      continue;
    }
    try {
      // Ask Stripe how far this card can go, right now.
      const status = await provider.value.provider.getPaymentStatus(payment.provider_payment_id);
      if (status.status === "captured" && status.amountCents) {
        // An earlier try already captured it: record what Stripe has.
        result.captures.push({ order_id: payment.order_id, payment_id: payment.id, captured_cents: status.amountCents, tip_cents: Math.max(0, status.amountCents - authorized), card_brand: status.cardBrand ?? payment.card_brand ?? null, card_last4: status.cardLast4 ?? payment.card_last4 ?? null });
        continue;
      }
      if (status.status !== "authorized") throw new PaymentProviderError(status.status === "voided" ? "the card's approval was cancelled or ran out" : "the card is no longer approved", "NOT_AUTHORIZED");
      const room = tipRoomCents(authorized, status.maxCapturableCents ?? authorized);
      const tip = Math.min(wanted, room);
      if (wanted > tip) result.problems.push(`${label}: this card could only take ${money(tip)} of the ${money(wanted)} tip (Stripe's limit for this card), so ${money(wanted - tip)} was not charged.`);
      const amount = authorized + tip;
      const captured = await provider.value.provider.capturePayment(payment.provider_payment_id, { amountCents: amount, idempotencyKey: `${options.keyPrefix}-${payment.id}-${amount}` });
      if (captured.status !== "captured") throw new PaymentProviderError("the card was not charged", "NOT_CAPTURED");
      const total = captured.amountCents ?? amount;
      result.captures.push({ order_id: payment.order_id, payment_id: payment.id, captured_cents: total, tip_cents: Math.max(0, total - authorized), card_brand: captured.cardBrand ?? payment.card_brand ?? null, card_last4: captured.cardLast4 ?? payment.card_last4 ?? null });
    } catch (cause) {
      // Captured by a try whose answer was lost? Then use what Stripe says.
      try {
        const status = await provider.value.provider.getPaymentStatus(payment.provider_payment_id);
        if (status.status === "captured" && status.amountCents) {
          result.captures.push({ order_id: payment.order_id, payment_id: payment.id, captured_cents: status.amountCents, tip_cents: Math.max(0, status.amountCents - authorized), card_brand: status.cardBrand ?? payment.card_brand ?? null, card_last4: status.cardLast4 ?? payment.card_last4 ?? null });
          continue;
        }
      } catch { /* report the original problem */ }
      logger.error("payments.tip_capture_failed", cause, { order_id: payment.order_id, prefix: options.keyPrefix });
      result.skipped.push(payment.order_id);
      result.problems.push(`${label}: ${cause instanceof Error ? cause.message : "the card could not be charged"}. It stays waiting — try again, or take cash for it.`);
    }
  }
  return result;
}
