import "server-only";

import { z } from "zod";

/** Stripe's actual ledger amounts, not an estimated processing rate. */
export const balanceTransactionSchema = z.object({
  id: z.string().startsWith("txn_"), amount: z.number().int(), fee: z.number().int(), net: z.number().int(),
  currency: z.literal("usd"), status: z.enum(["pending", "available"]), available_on: z.number().int(),
});
export type BalanceTransaction = z.infer<typeof balanceTransactionSchema>;
export type PayoutItem = {
  id: string; kind: "charge" | "tip_charge" | "refund"; source_id: string; provider_id: string | null;
  payment_id: string; operation_pending?: boolean; ledger_status: string; refunded_cents: number; transaction: BalanceTransaction | null;
};
export type PayoutBatch = {
  id: string; workspace_id: string; location_id: string; business_date: string; account_id: string; bank_id: string;
  connection_id: string; environment: "sandbox" | "production"; state: string; net_cents: number | null;
  submitted_at: string | null; stripe_payout_id: string | null;
};
export type StripePayout = { id: string; amount: number; currency: string; status: string; arrival_date: number; destination: string; method: string; type: string; livemode: boolean; metadata: Record<string, string> };
export class PayoutWaiting extends Error {}
export class PayoutReview extends Error {}

export function payoutTotals(transactions: BalanceTransaction[]) {
  const totals = { gross: 0, refunds: 0, fees: 0, net: 0 };
  const ids = new Set<string>();
  for (const transaction of transactions) {
    const t = balanceTransactionSchema.parse(transaction);
    if (ids.has(t.id) || t.net !== t.amount - t.fee) throw new PayoutReview("Card settlement records need review before payout.");
    if (t.status !== "available") throw new PayoutWaiting("Waiting for card payments to settle.");
    ids.add(t.id);
    if (t.amount >= 0) totals.gross += t.amount; else totals.refunds -= t.amount;
    totals.fees += t.fee;
    totals.net += t.net;
  }
  return totals;
}

export function createCloseoutStripe(secretKey: string) {
  async function call<T>(path: string, body?: URLSearchParams, key?: string): Promise<T> {
    const response = await fetch(`https://api.stripe.com/v1${path}`, {
      method: body ? "POST" : "GET", cache: "no-store", signal: AbortSignal.timeout(12_000),
      headers: { Authorization: `Bearer ${secretKey}`, ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(key ? { "Idempotency-Key": key } : {}) }, body,
    });
    const result = await response.json();
    if (!response.ok) {
      // Never copy Stripe response bodies (which may include sensitive details) to the POS.
      if (result.error?.code === "balance_insufficient") throw new PayoutWaiting("Stripe's available card balance is too low. The payout will be checked again.");
      throw new Error(`Stripe payout request failed (HTTP ${response.status}).`);
    }
    return result as T;
  }
  return {
    call,
    async account() {
      const account = await call<{ id: string; default_currency: string; payouts_enabled: boolean; business_profile?: { name?: string }; settings: { payouts: { schedule: { interval: string } } } }>("/account");
      type Bank = { id: string; object: string; currency: string; default_for_currency: boolean; status: string; bank_name: string; last4: string };
      // Stripe exposes external bank listings only to live keys. Sandbox payouts
      // still validate their destination at creation; no real funds can move.
      let banks: Bank[] = [];
      let bankLookupAvailable = false;
      if (!secretKey.startsWith("sk_test_")) {
        try {
          banks = (await call<{ data: Bank[] }>(`/accounts/${encodeURIComponent(account.id)}/external_accounts?object=bank_account&limit=100`)).data;
          bankLookupAvailable = true;
        } catch { /* Standard accounts may not expose Connect's bank-list API.
                     Stripe supports paying the configured default bank without
                     retrieving or changing its private banking information. */ }
      }
      return { ...account, banks, bankLookupAvailable };
    },
    async transaction(item: PayoutItem): Promise<BalanceTransaction | null> {
      if (item.operation_pending || ["pending", "authorized"].includes(item.ledger_status)) throw new PayoutWaiting("Waiting for card capture and delivery tips to be recorded.");
      if (item.transaction && item.kind === "refund") {
        if (item.transaction.status === "available") return balanceTransactionSchema.parse(item.transaction);
        return balanceTransactionSchema.parse(await call(`/balance_transactions/${encodeURIComponent(item.transaction.id)}`));
      }
      if (!item.provider_id) {
        if (["failed", "voided", "canceled"].includes(item.ledger_status)) return null;
        throw new PayoutWaiting("Waiting for a card payment or refund to finish.");
      }
      if (item.kind !== "refund") {
        const pi = await call<{ id: string; status: string; livemode: boolean; latest_charge: null | { id: string; amount_refunded: number; balance_transaction: unknown; payment_method_details: { type: string }; metadata: Record<string,string> }; metadata: Record<string,string> }>(`/payment_intents/${encodeURIComponent(item.provider_id)}?expand[]=latest_charge.balance_transaction`);
        if (pi.livemode !== secretKey.startsWith("sk_live_")) throw new PayoutReview("A card payment belongs to a different Stripe mode.");
        if (pi.id !== item.provider_id || (pi.metadata.wayne_payment_id && pi.metadata.wayne_payment_id !== item.payment_id)) throw new PayoutReview("A card payment does not match this store's closeout.");
        if (pi.status === "canceled" || (pi.status === "requires_payment_method" && item.ledger_status === "failed")) return null;
        if (pi.status !== "succeeded" || !pi.latest_charge?.balance_transaction) throw new PayoutWaiting("Waiting for card capture and settlement, including delivery tips.");
        if (!["card", "card_present"].includes(pi.latest_charge.payment_method_details.type)) throw new PayoutReview("A closeout payment is not a card payment.");
        if (pi.latest_charge.amount_refunded > Number(item.refunded_cents)) throw new PayoutWaiting("A Stripe refund is not yet recorded in the POS. Reconcile it before payout.");
        return balanceTransactionSchema.parse(pi.latest_charge.balance_transaction);
      }
      const refund = await call<{ id: string; status: string; balance_transaction: unknown }>(`/refunds/${encodeURIComponent(item.provider_id)}?expand[]=balance_transaction`);
      if (refund.id !== item.provider_id) throw new PayoutReview("A card refund does not match this closeout.");
      if (["failed", "canceled"].includes(refund.status)) return null;
      if (refund.status !== "succeeded" || !refund.balance_transaction) throw new PayoutWaiting("Waiting for a card refund to finish.");
      return balanceTransactionSchema.parse(refund.balance_transaction);
    },
    async available() {
      const balance = await call<{ available: Array<{ currency: string; source_types?: { card?: number } }> }>("/balance");
      return balance.available.find((b) => b.currency === "usd")?.source_types?.card ?? 0;
    },
    async find(batch: PayoutBatch) {
      if (batch.stripe_payout_id) return call<StripePayout>(`/payouts/${encodeURIComponent(batch.stripe_payout_id)}`);
      if (!batch.submitted_at) return null;
      let cursor = "";
      for (let page = 0; page < 100; page++) {
        const list = await call<{ data: StripePayout[]; has_more: boolean }>(`/payouts?limit=100&created[gte]=${Math.floor(Date.parse(batch.submitted_at) / 1000) - 60}${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`);
        const matches = list.data.filter((p) => p.metadata.wayne_closeout_payout === batch.id);
        if (matches.length > 1) throw new PayoutReview("More than one bank payout matches this closeout. Review Stripe.");
        if (matches[0]) return matches[0];
        if (!list.has_more) return null;
        cursor = list.data.at(-1)?.id ?? "";
        if (!cursor) break;
      }
      throw new PayoutReview("The payout history could not be fully checked. Review Stripe before retrying.");
    },
    async create(batch: PayoutBatch) {
      if (!batch.submitted_at || !Number.isSafeInteger(batch.net_cents) || batch.net_cents! <= 0) throw new PayoutReview("The payout amount has not been saved.");
      // Stripe can expire idempotency keys after 24 hours. Never POST again
      // outside a shorter retry window, even when the list lookup found nothing.
      if (Date.now() - Date.parse(batch.submitted_at) >= 23 * 60 * 60 * 1000) throw new PayoutReview("The payout outcome needs review in Stripe before another transfer.");
      const form = new URLSearchParams({ amount: String(batch.net_cents), currency: "usd", method: "standard", source_type: "card", ...(batch.bank_id === "default" ? {} : { destination: batch.bank_id }),
        description: `Store closeout ${batch.business_date}`, "metadata[wayne_closeout_payout]": batch.id, "metadata[wayne_workspace_id]": batch.workspace_id });
      return call<StripePayout>("/payouts", form, `closeout-bank-payout-${batch.id}`);
    },
  };
}

export function verifyPayout(batch: PayoutBatch, payout: StripePayout) {
  if (payout.amount !== Number(batch.net_cents) || payout.currency !== "usd" || (batch.bank_id === "default" ? payout.type !== "bank_account" || !payout.destination.startsWith("ba_") : payout.destination !== batch.bank_id) || payout.method !== "standard"
    || payout.livemode !== (batch.environment === "production") || payout.metadata.wayne_closeout_payout !== batch.id
    || (batch.stripe_payout_id && batch.stripe_payout_id !== payout.id)) throw new PayoutReview("Stripe's payout does not match this closeout. Review before retrying.");
}
