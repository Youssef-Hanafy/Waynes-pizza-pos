/**
 * Pure mapping of a Stripe card-present PaymentIntent (kept apart from the
 * network code so it can be unit tested).
 */

type CardPresent = { brand?: string | null; last4?: string | null; overcapture_supported?: boolean | null };
type Charge = { receipt_url?: string | null; payment_method_details?: { card_present?: CardPresent | null; card?: CardPresent | null } | null };

export type StripeTerminalIntent = {
  id?: string;
  status?: string;
  amount?: number;
  amount_capturable?: number;
  client_secret?: string;
  latest_charge?: Charge | string | null;
  last_payment_error?: { message?: string; decline_code?: string; code?: string } | null;
  metadata?: Record<string, string>;
};

/**
 * open       waiting for a card (requires_payment_method), including after a
 *            decline — the same intent is reused for the next card
 * processing Stripe is still working on it
 * authorized / captured / canceled  settled
 */
export type TerminalIntentState = "open" | "processing" | "authorized" | "captured" | "canceled";

export type TerminalIntentResult = {
  id: string;
  clientSecret: string;
  state: TerminalIntentState;
  providerStatus: string;
  amountCents: number | null;
  cardBrand: string | null;
  cardLast4: string | null;
  receiptUrl: string | null;
  /** The last decline, in words staff can say to the customer. */
  declineMessage: string | null;
  /** Held for its tip: the most it can be captured for (order + tip), or null. */
  maxCaptureCents: number | null;
};

export function terminalIntentState(status: string | undefined): TerminalIntentState {
  switch (status) {
    case "succeeded": return "captured";
    case "requires_capture": return "authorized";
    case "canceled": return "canceled";
    case "processing": case "requires_confirmation": case "requires_action": return "processing";
    default: return "open";
  }
}

export function mapTerminalIntent(intent: StripeTerminalIntent): TerminalIntentResult {
  const charge = typeof intent.latest_charge === "object" && intent.latest_charge ? intent.latest_charge : null;
  const card = charge?.payment_method_details?.card_present ?? charge?.payment_method_details?.card ?? null;
  const declined = intent.last_payment_error;
  return {
    id: intent.id ?? "",
    clientSecret: intent.client_secret ?? "",
    state: terminalIntentState(intent.status),
    providerStatus: intent.status ?? "",
    amountCents: typeof intent.amount === "number" ? intent.amount : null,
    cardBrand: card?.brand ?? null,
    cardLast4: card?.last4 ?? null,
    receiptUrl: charge?.receipt_url ?? null,
    declineMessage: declined ? declineWords(declined.decline_code ?? declined.code) : null,
    maxCaptureCents: intent.status === "requires_capture" ? terminalCaptureLimit(intent, card) : null,
  };
}

/** Plain words for the common declines; everything else is "declined". */
export function declineWords(code: string | undefined): string {
  switch (code) {
    case "insufficient_funds": return "Declined: not enough funds. Try another card.";
    case "expired_card": return "Declined: the card has expired. Try another card.";
    case "incorrect_pin": case "invalid_pin": return "Wrong PIN. Try again.";
    case "card_not_supported": return "This card type isn't accepted. Try another card.";
    case "offline_pin_required": case "online_or_offline_pin_required": return "The card needs its PIN. Insert the card and enter the PIN.";
    default: return "The card was declined. Try another card.";
  }
}

/**
 * Overcapture on the M2 (owner, 2026-10-13): a card that supports it can be
 * captured for up to 50% or $50 more than authorised, whichever is greater —
 * that room is the tip written on the slip.  Otherwise only what was authorised.
 */
export function terminalCaptureLimit(intent: Pick<StripeTerminalIntent, "amount" | "amount_capturable">, card: CardPresent | null): number | null {
  const authorized = typeof intent.amount_capturable === "number" && intent.amount_capturable > 0 ? intent.amount_capturable : intent.amount ?? null;
  if (authorized === null) return null;
  return card?.overcapture_supported ? authorized + Math.max(Math.round(authorized / 2), 5000) : authorized;
}
