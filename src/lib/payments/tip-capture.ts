import "server-only";

import { logger } from "@/lib/logging/logger";
import type { createServiceSupabaseClient } from "@/lib/supabase/server";
import { resolvePaymentProvider } from "./config";
import { PaymentProviderError } from "./provider";

import { runTipOperation } from "./tip-operation";

/** Shared durable capture/reconciliation for Tips, driver cash-out and recovery. */

type Service = ReturnType<typeof createServiceSupabaseClient>;

export type TipRequest = { order_id: string; tip_cents: number; /** Recovery targets the saved payment, even if the order has other tenders. */ payment_id?: string };

export type TipCapture = {
  order_id: string;
  payment_id: string;
  /** What the card was captured for in total. */
  captured_cents: number;
  /** Tip added by this capture (on top of anything already in the authorised amount). */
  tip_cents: number;
  card_brand: string | null;
  card_last4: string | null;
  is_test?: boolean;
  provider_payment_id?: string | null;
};

export type TipCaptureResult = {
  captures: TipCapture[];
  /** Orders whose card could not be captured — they stay waiting. */
  skipped: string[];
  /** What went wrong or was cut down, in words for the cashier. */
  problems: string[];
};

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
  /** Audit origin only. Never part of a financial idempotency key. */
  keyPrefix: string;
}): Promise<TipCaptureResult> {
  const { service, workspaceId, requests } = options;
  const result: TipCaptureResult = { captures: [], skipped: [], problems: [] };
  if (!requests.length) return result;

  const { data: rows, error } = await service.from("payments")
    .select("id, order_id, provider, provider_payment_id, amount_cents, card_brand, card_last4, metadata, status, order:orders!inner(order_number, daily_number, workspace_id)")
    .in("order_id", requests.map((request) => request.order_id))
    .in("status", ["authorized", "captured", "failed"]).eq("method", "card").in("provider", ["stripe", "test"])
    .eq("orders.workspace_id", workspaceId).order("created_at", { ascending: false });
  if (error) throw new PaymentProviderError("The held cards could not be loaded.", "DATABASE", true);

  let resolved: Awaited<ReturnType<typeof resolvePaymentProvider>> | null = null;
  const stripe = async () => (resolved ??= await resolvePaymentProvider("online", { workspaceId, locationId: options.locationId }));

  for (const request of requests) {
    const candidates = rows?.filter((row) => row.order_id === request.order_id) ?? [];
    const payment = request.payment_id ? candidates.find((row) => row.id === request.payment_id)
      : candidates.find((row) => row.status === "authorized") ?? candidates[0];
    const orderNumber = (payment?.order as unknown as { order_number?: string } | null)?.order_number ?? "";
    if (!payment) { result.skipped.push(request.order_id); result.problems.push("A card is no longer waiting for a tip (already charged or cancelled)."); continue; }
    const daily = (payment.order as unknown as { daily_number?: number | null }).daily_number;
    const label = `#${daily ?? (orderNumber.replace(/^W0*/, "") || payment.order_id.slice(0, 8))}`;
    const wanted = Math.max(0, Math.round(request.tip_cents || 0));
    try {
      const completed = await runTipOperation({
        service, workspaceId, wanted, origin: options.keyPrefix,
        payment: { ...payment, metadata: (payment.metadata ?? {}) as Record<string, unknown> },
        testTipRoom: tipRoomCents(payment.amount_cents, (payment.metadata as Record<string, unknown> | null)?.max_capture_cents as number | undefined),
        provider: async () => {
          const resolved = await stripe();
          if (!resolved.ok) throw new PaymentProviderError("Stripe is not configured for this payment.", "NOT_CONFIGURED");
          return resolved.value.provider;
        },
      });
      result.captures.push(completed.capture);
      result.problems.push(...completed.problems.map((problem) => `${label}: ${problem}`));
    } catch (cause) {
      logger.error("payments.tip_capture_failed", cause, { order_id: payment.order_id, origin: options.keyPrefix });
      result.skipped.push(payment.order_id);
      result.problems.push(`${label}: ${cause instanceof Error ? cause.message : "The payment outcome is unknown. Retry to reconcile; do not charge again."}`);
    }
  }
  return result;
}
