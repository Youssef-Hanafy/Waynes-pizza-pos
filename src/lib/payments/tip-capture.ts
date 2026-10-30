import "server-only";

import { logger } from "@/lib/logging/logger";
import type { createServiceSupabaseClient } from "@/lib/supabase/server";
import { resolvePaymentProvider } from "./config";
import { PaymentProviderError } from "./provider";

/**
 * Tip adjust (owner, 2026-10-13): every card is authorised for the order and
 * captured later with the tip written on the signed slip.  A card-present
 * (Reader M2) card can be overcaptured — one capture for order + tip (up to
 * 50% or $50 more, whichever is greater).  A keyed card can't (card-not-present
 * needs IC+ pricing), so its tip is charged ON ITS OWN and the order is
 * captured on its approval (owner, 2026-10-29, after #36 / W001228).
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
    .select("id, order_id, provider, provider_payment_id, amount_cents, card_brand, card_last4, metadata, order:orders!inner(order_number, daily_number, workspace_id)")
    .in("order_id", requests.map((request) => request.order_id))
    .eq("status", "authorized").eq("method", "card").in("provider", ["stripe", "test"])
    .eq("orders.workspace_id", workspaceId);
  if (error) throw new PaymentProviderError("The held cards could not be loaded.", "DATABASE", true);

  let resolved: Awaited<ReturnType<typeof resolvePaymentProvider>> | null = null;
  const stripe = async () => (resolved ??= await resolvePaymentProvider("online", { workspaceId, locationId: options.locationId }));

  for (const request of requests) {
    const payment = rows?.find((row) => row.order_id === request.order_id);
    const orderRow = payment?.order as unknown as { order_number?: string; daily_number?: number | null } | null;
    const orderNumber = orderRow?.order_number ?? "";
    if (!payment) { result.skipped.push(request.order_id); result.problems.push("A card is no longer waiting for a tip (already charged or cancelled)."); continue; }
    // The slip number staff read off the paper (#12), owner 2026-10-28.
    const label = `#${orderRow?.daily_number ?? (orderNumber.replace(/^W0*/, "") || payment.order_id.slice(0, 8))}`;
    const wanted = Math.max(0, Math.round(request.tip_cents || 0));
    const metadata = (payment.metadata ?? {}) as Record<string, unknown>;
    const authorized = payment.amount_cents as number;
    // A tip already charged on its own by an earlier try (see below).
    let separateTip = typeof metadata.tip_charge_cents === "number" ? metadata.tip_charge_cents : 0;

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
        // An earlier try already captured it: record what Stripe has (plus a tip it charged on its own).
        result.captures.push({ order_id: payment.order_id, payment_id: payment.id, captured_cents: status.amountCents + separateTip, tip_cents: Math.max(0, status.amountCents + separateTip - authorized), card_brand: status.cardBrand ?? payment.card_brand ?? null, card_last4: status.cardLast4 ?? payment.card_last4 ?? null });
        continue;
      }
      if (status.status !== "authorized") throw new PaymentProviderError(status.status === "voided" ? "the card's approval was cancelled or ran out" : "the card is no longer approved", "NOT_AUTHORIZED");
      const room = Math.max(0, (status.maxCapturableCents ?? authorized) - authorized);
      const stripeApi = provider.value.provider;
      // A tip already went through on its own on an earlier try whose order charge didn't finish.
      // Never charge a tip twice, and never record the order without the tip that was charged.
      const alreadyChargedTip = separateTip > 0 ? separateTip : 0;
      if (alreadyChargedTip && alreadyChargedTip !== wanted) {
        result.skipped.push(payment.order_id);
        result.problems.push(`${label}: a ${money(alreadyChargedTip)} tip was already charged on its own earlier, but the tip typed now is ${money(wanted)}. Nothing more was charged. Set the tip back to ${money(alreadyChargedTip)} to finish this order, or check it in Stripe.`);
        continue;
      }

      // A tip that doesn't fit on the approval (keyed / card-not-present cards: no
      // overcapture without IC+, confirmed by Stripe 2026-10-28 and again 2026-10-29).
      /*
       * Owner, 2026-10-29 (order #36 / W001228): the tip is charged ON ITS OWN, separate
       * from the order — never a new "order + tip" charge.  That combined charge was
       * made while the order's approval still held its money, so the card needed about
       * double the order free; on #36 the bank refused $49.03 and the screen showed
       * "declined" even though everything ended up paid.  Now:
       *   1. charge just the tip on the saved card (only the tip has to be free);
       *   2. then charge the order on the approval it already has (can't be declined).
       * If the tip is refused, NOTHING is charged and the card stays waiting with the
       * tip typed in (owner, 2026-10-28: a tip is never silently dropped).
       */
      if (alreadyChargedTip > 0 || (wanted > room && stripeApi.chargeSavedCard && status.paymentMethodId && status.customerId)) {
        let tipCharged: { id: string; cents: number; brand: string | null; last4: string | null } | null =
          alreadyChargedTip ? { id: String(metadata.tip_charge_intent ?? ""), cents: alreadyChargedTip, brand: null, last4: null } : null;
        if (!tipCharged) {
          try {
            if (!stripeApi.chargeSavedCard || !status.paymentMethodId || !status.customerId) throw new PaymentProviderError("the saved card can't be charged", "NOT_SUPPORTED");
            const tipOnly = await stripeApi.chargeSavedCard({
              customerId: status.customerId, paymentMethodId: status.paymentMethodId, amountCents: wanted,
              // Same key as the 10/28 fallback, so a tip charged by an earlier try is never charged twice.
              idempotencyKey: `${options.keyPrefix}-tiponly-${payment.id}-${wanted}`,
              note: `${label} tip`,
              metadata: { wayne_payment_id: payment.id, wayne_order_number: orderNumber, wayne_tip_only: "true", wayne_tip_for: payment.provider_payment_id },
            });
            if (tipOnly.status !== "captured" || !tipOnly.providerPaymentId) throw new PaymentProviderError(tipOnly.status === "failed" ? "the card was declined for the tip" : "the tip charge is still pending — try the cash-out again in a minute", "NOT_CAPTURED", tipOnly.status !== "failed");
            tipCharged = { id: tipOnly.providerPaymentId, cents: tipOnly.amountCents ?? wanted, brand: tipOnly.cardBrand ?? null, last4: tipOnly.cardLast4 ?? null };
          } catch (tipCause) {
            // No answer: the tip charge may have gone through; a retry reuses its key, so it never charges twice.
            if (tipCause instanceof PaymentProviderError && tipCause.retryable) throw tipCause;
            logger.error("payments.tip_only_failed", tipCause, { payment_id: payment.id });
            const tipReason = tipCause instanceof Error ? tipCause.message.replace(/\.$/, "") : "the card was refused";
            result.skipped.push(payment.order_id);
            result.problems.push(`${label}: Stripe refused the ${money(wanted)} tip (${tipReason}). Nothing was charged — the order's approval is still holding and the card stays waiting with the tip typed in. Try again, or set this tip to 0 to charge just the order and pay the driver the tip in cash.`);
            continue;
          }
          // Remembered on the payment straight away, so a retry after a lost answer still counts the tip.
          const { error: tipNoteError } = await service.from("payments").update({
            metadata: { ...metadata, tip_charge_intent: tipCharged.id, tip_charge_cents: tipCharged.cents, tip_charged_separately: true },
          }).eq("id", payment.id);
          if (tipNoteError) logger.error("payments.tip_only_record_failed", new Error(tipNoteError.message), { payment_id: payment.id, intent: tipCharged.id });
          separateTip = tipCharged.cents;
        }
        let orderCapture: Awaited<ReturnType<typeof stripeApi.capturePayment>>;
        try {
          orderCapture = await stripeApi.capturePayment(payment.provider_payment_id, { amountCents: authorized, idempotencyKey: `${options.keyPrefix}-${payment.id}-${authorized}` });
          if (orderCapture.status !== "captured") throw new PaymentProviderError("the order was not charged on its approval", "NOT_CAPTURED", true);
        } catch (captureCause) {
          if (captureCause instanceof PaymentProviderError && captureCause.retryable) throw captureCause;
          logger.error("payments.tip_only_order_capture_failed", captureCause, { payment_id: payment.id, tip_intent: tipCharged.id });
          result.skipped.push(payment.order_id);
          result.problems.push(`${label}: the ${money(tipCharged.cents)} tip was charged on its own, but the order itself could not be charged (${captureCause instanceof Error ? captureCause.message : "refused"}). Don't charge the tip again — check this order in Stripe.`);
          continue;
        }
        const orderCents = orderCapture.amountCents ?? authorized;
        result.captures.push({
          order_id: payment.order_id, payment_id: payment.id, captured_cents: orderCents + tipCharged.cents, tip_cents: Math.max(0, orderCents + tipCharged.cents - authorized),
          card_brand: orderCapture.cardBrand ?? tipCharged.brand ?? payment.card_brand ?? null, card_last4: orderCapture.cardLast4 ?? tipCharged.last4 ?? payment.card_last4 ?? null,
        });
        // The normal path for a keyed card now: no warning, nothing to read as "declined".
        continue;
      } else if (wanted > 0 && room === 0 && !(status.paymentMethodId && status.customerId)) {
        result.problems.push(`${label}: this card was approved before tips could be added to it, so only the order was charged.`);
      }
      const tip = Math.min(wanted, room);
      if (wanted > tip && room > 0) result.problems.push(`${label}: this card could only take ${money(tip)} of the ${money(wanted)} tip (Stripe's limit for this card), so ${money(wanted - tip)} was not charged.`);
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
          result.captures.push({ order_id: payment.order_id, payment_id: payment.id, captured_cents: status.amountCents + separateTip, tip_cents: Math.max(0, status.amountCents + separateTip - authorized), card_brand: status.cardBrand ?? payment.card_brand ?? null, card_last4: status.cardLast4 ?? payment.card_last4 ?? null });
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
