import { getCurrentAccess } from "@/lib/auth/access";
import { hasPermission } from "@/lib/auth/permissions";
import { logger } from "@/lib/logging/logger";
import { resolvePaymentProvider } from "@/lib/payments/config";
import { PaymentProviderError } from "@/lib/payments/provider";
import { posKeyedCardIntentSchema } from "@/lib/payments/schemas";
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server";

/**
 * Opens a Stripe-hosted card field for an order already on the POS (the card is keyed in by staff, usually over the phone).
 *
 * A delivery card uses the restaurant "tip adjust" flow (owner, 2026-10-11): the
 * card is authorised for the order; the tip on the slip the driver brings back
 * is added at the driver's cash-out and the card is captured ONCE for order +
 * tip.  Every other keyed card (a phone pickup) is charged on the spot for the
 * order plus any tip given on the phone, and the order is closed (owner,
 * 2026-10-13: "the only orders you should have to manually add tips is those
 * that are in the delivery").
 *
 * A delivery customer can also tip on the phone (owner, 2026-10-31): the POS
 * saves the tip on the order first (wayne_pos_set_tip), so this approval is
 * created ONCE for order + tip ($30 + $5 → $35).  The amount the cashier saw is
 * sent as expected_amount_cents; a different amount (another register changed
 * the order, a stale screen, a retry with a changed tip) is refused before
 * anything reaches Stripe.  The tip inside the approval is written on the
 * payment (tip_included_cents) and on Stripe's record; the driver's cash-out
 * then only ever charges an EXTRA tip on top of it (tip-operation.ts).
 */
export async function POST(request: Request) {
  const access = await getCurrentAccess();
  if (!hasPermission(access, "pos.access") || !access?.workspace_id) return Response.json({ error: "POS access required." }, { status: 403 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const parsed = posKeyedCardIntentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid delivery order." }, { status: 400 });

  const resolved = await resolvePaymentProvider("online", { workspaceId: access.workspace_id, locationId: access.location_id ?? null });
  if (!resolved.ok || resolved.value.provider.code !== "stripe") return Response.json({ error: "Stripe keyed card payment is not available." }, { status: 503 });

  const service = createServiceSupabaseClient();
  const { data: order } = await service.from("orders")
    .select("id, source, fulfillment_type, total_cents, tip_cents")
    .eq("id", parsed.data.order_id).eq("workspace_id", access.workspace_id).maybeSingle();
  if (!order) return Response.json({ error: "Order not found." }, { status: 404 });

  const userClient = await createServerSupabaseClient();
  const expected = parsed.data.expected_amount_cents;
  const expectedTip = parsed.data.expected_tip_cents;
  // Stale screen check before anything is opened: what is owed now must be what the cashier is about to approve.
  if (expected !== undefined) {
    const { data: paidData, error: paidError } = await userClient.rpc("wayne_order_paid_cents", { target_order_id: order.id });
    if (paidError || typeof paidData !== "number") return Response.json({ error: "The order total could not be checked. Nothing was charged; try again." }, { status: 503 });
    const owed = order.total_cents - paidData;
    if (owed !== expected || (expectedTip !== undefined && paidData === 0 && order.tip_cents !== expectedTip)) {
      return Response.json(changedAnswer(owed, paidData === 0 ? order.tip_cents : 0), { status: 409 });
    }
  }
  const { data: beginData, error: beginError } = await userClient.rpc("wayne_begin_payment", {
    payload: { order_id: parsed.data.order_id, idempotency_key: parsed.data.idempotency_key, entry: "pos_keyed_card", method: "card" },
  });
  if (beginError?.code === "40001") {
    // A keyed card already open on this order. If its register lost the answer and gave up, carry
    // on with THAT approval (same payment, same Stripe PaymentIntent, same amount) instead of
    // leaving the order unpayable. A PaymentIntent can only ever be approved once.
    const resumed = await resumeAbandonedKeyedCard({ service, orderId: order.id, expected, provider: resolved.value.provider, workspaceName: access.workspace_name ?? "Store", delivery: order.fulfillment_type === "delivery" });
    if (resumed) return resumed;
    return Response.json({ error: "A payment is already in progress for this order." }, { status: 409 });
  }
  if (beginError || !beginData) return Response.json({ error: "The card payment could not be opened." }, { status: 400 });
  const begun = beginData as { payment_id: string; duplicate: boolean; amount_cents: number; order_number: string };

  try {
    let intent;
    if (begun.duplicate) {
      const { data: payment } = await service.from("payments").select("provider_payment_id, amount_cents").eq("id", begun.payment_id).maybeSingle();
      // A replay of the same request may only continue the SAME amount; a changed total is a new payment, never this one.
      if (expected !== undefined && payment && payment.amount_cents !== expected) {
        return Response.json({ error: `This card was already started for ${dollars(payment.amount_cents)}, not ${dollars(expected)}. Check the ticket in Payments before trying again; do not key the card in again.` }, { status: 409 });
      }
      if (!payment?.provider_payment_id) return Response.json({ error: "This payment is still being prepared. Check the ticket before trying again." }, { status: 409 });
      intent = await resolved.value.provider.getOnlinePaymentIntent(payment.provider_payment_id);
    } else {
      const delivery = order.fulfillment_type === "delivery";
      // The payment row is now open, so the tip is locked (wayne_pos_set_tip refuses while it is pending): read what this approval holds.
      const { data: locked } = await service.from("orders").select("total_cents, tip_cents").eq("id", order.id).maybeSingle();
      const firstPayment = locked ? locked.total_cents === begun.amount_cents : false;
      const tipIncluded = firstPayment ? Math.max(0, locked?.tip_cents ?? 0) : 0;
      if (!locked || (expected !== undefined && begun.amount_cents !== expected) || (expectedTip !== undefined && firstPayment && tipIncluded !== expectedTip)) {
        // The order changed between the check above and the payment opening: close this payment before Stripe ever sees it.
        await service.rpc("wayne_settle_payment", { payload: { payment_id: begun.payment_id, status: "failed", failure_reason: "The order total changed before the card was approved." } });
        return Response.json(changedAnswer(begun.amount_cents, tipIncluded), { status: 409 });
      }
      intent = await createKeyedIntent({
        service, provider: resolved.value.provider, paymentId: begun.payment_id, idempotencyKey: parsed.data.idempotency_key,
        orderNumber: begun.order_number, amountCents: begun.amount_cents, tipIncluded, delivery, workspaceName: access.workspace_name ?? "Store",
      });
    }
    return Response.json({ payment_id: begun.payment_id, client_secret: intent.clientSecret, payment_status: intent.status === "captured" ? "captured" : intent.status === "authorized" ? "authorized" : "pending" }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    const error = cause instanceof PaymentProviderError ? cause : null;
    logger.error("pos.keyed_card_intent_failed", cause, { code: error?.code, order_id: parsed.data.order_id });
    return Response.json({ error: error?.message ?? "The keyed card payment could not be prepared." }, { status: error?.retryable ? 502 : 400 });
  }
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type Service = ReturnType<typeof createServiceSupabaseClient>;
type Provider = Extract<Awaited<ReturnType<typeof resolvePaymentProvider>>, { ok: true }>["value"]["provider"];

/**
 * Creates the Stripe PaymentIntent for a payment row and records it. Every input is derived from the
 * payment and the (locked) order, so the same call with the same idempotency key always asks Stripe
 * for the same thing — Stripe answers a repeat with the PaymentIntent it already made.
 */
async function createKeyedIntent(input: { service: Service; provider: Provider; paymentId: string; idempotencyKey: string; orderNumber: string; amountCents: number; tipIncluded: number; delivery: boolean; workspaceName: string }) {
  const { service, tipIncluded, delivery } = input;
  const intent = await input.provider.createOnlinePaymentIntent({
    amountCents: input.amountCents, idempotencyKey: input.idempotencyKey, referenceId: input.orderNumber,
    note: `${input.workspaceName} order ${input.orderNumber} (keyed card${tipIncluded ? ` — order ${dollars(input.amountCents - tipIncluded)} + ${dollars(tipIncluded)} tip` : ""}${delivery ? `${tipIncluded ? "; extra" : " —"} tip added at cash-out` : ""})`, paymentId: input.paymentId, receiptEmail: null,
    tipAdjust: delivery, tipCents: tipIncluded,
  });
  const { data: current } = await service.from("payments").select("metadata").eq("id", input.paymentId).maybeSingle();
  const metadata = {
    ...((current?.metadata ?? {}) as Record<string, unknown>), ...(delivery ? { tip_adjust: true, held_for: "delivery_tip" } : {}),
    // How much of this one charge is the tip (receipts, refunds, disputes); the cash-out adds only an extra on top.
    ...(tipIncluded ? { tip_included_cents: tipIncluded, order_cents: input.amountCents - tipIncluded } : {}),
  };
  const { error } = await service.from("payments").update({ provider_payment_id: intent.providerPaymentId, provider_status: intent.providerStatus, metadata }).eq("id", input.paymentId);
  if (error) throw new PaymentProviderError("The payment could not be prepared. Please try again.", "DATABASE", true);
  return intent;
}

/** Longer than the register waits for this route (15 s): an open keyed card older than this was given up on. */
const ABANDONED_KEYED_CARD_MS = 20_000;

/**
 * Verification fix (2026-10-31): a keyed card whose answer was lost left a 'pending' payment that
 * blocked every later payment on the order ("A payment is already in progress") — cash included.
 * The register's retry now continues that same payment instead.  Only a keyed card, only once its
 * register has given up (older than ABANDONED_KEYED_CARD_MS, so a second register can't grab a card
 * still being typed), and only for the amount the retrying cashier sees.
 */
async function resumeAbandonedKeyedCard(input: { service: Service; orderId: string; expected: number | undefined; provider: Provider; workspaceName: string; delivery: boolean }): Promise<Response | null> {
  const { service } = input;
  const { data: open } = await service.from("payments")
    .select("id, provider_payment_id, amount_cents, created_at, metadata, idempotency_key, order:orders!inner(order_number, total_cents, tip_cents)")
    .eq("order_id", input.orderId).eq("status", "pending").eq("method", "card").eq("provider", "stripe")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!open || (open.metadata as Record<string, unknown> | null)?.entry !== "pos_keyed_card") return null;
  if (Date.now() - Date.parse(open.created_at as string) < ABANDONED_KEYED_CARD_MS) return null;
  if (input.expected !== undefined && open.amount_cents !== input.expected) {
    return Response.json({ error: `A card for ${dollars(open.amount_cents)} is still open on this order. Check the card in Payments before trying a different amount; do not key the card in again.`, code: "OPEN_PAYMENT", amount_cents: open.amount_cents }, { status: 409 });
  }
  const order = open.order as unknown as { order_number: string; total_cents: number; tip_cents: number };
  try {
    const intent = open.provider_payment_id
      ? await input.provider.getOnlinePaymentIntent(open.provider_payment_id)
      : await createKeyedIntent({
        service, provider: input.provider, paymentId: open.id, idempotencyKey: open.idempotency_key as string, orderNumber: order.order_number,
        amountCents: open.amount_cents, tipIncluded: order.total_cents === open.amount_cents ? Math.max(0, order.tip_cents) : 0, delivery: input.delivery, workspaceName: input.workspaceName,
      });
    if (intent.amountCents !== null && intent.amountCents !== undefined && intent.amountCents !== open.amount_cents) return null;
    return Response.json({ payment_id: open.id, client_secret: intent.clientSecret, resumed: true, payment_status: intent.status === "captured" ? "captured" : intent.status === "authorized" ? "authorized" : "pending" }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    logger.error("pos.keyed_card_resume_failed", cause, { order_id: input.orderId, payment_id: open.id });
    return null;
  }
}

/** The order changed since the screen showed it: say what it comes to now. Nothing was charged. */
function changedAnswer(owedCents: number, tipCents: number) {
  return {
    error: `The order now comes to ${dollars(owedCents)}${tipCents ? ` (order ${dollars(owedCents - tipCents)} + ${dollars(tipCents)} tip)` : ""}. Nothing was charged. Check the amount with the customer and press Approve again.`,
    code: "AMOUNT_CHANGED", amount_cents: owedCents, tip_cents: tipCents,
  };
}
