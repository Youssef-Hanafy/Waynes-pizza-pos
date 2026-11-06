import "server-only";

import type { createServiceSupabaseClient } from "@/lib/supabase/server";
import { stripeSecrets } from "./capabilities";
import { createCloseoutStripe, payoutTotals, PayoutReview, PayoutWaiting, verifyPayout, type PayoutBatch, type PayoutItem, type BalanceTransaction } from "./closeout-payout";

type Service = ReturnType<typeof createServiceSupabaseClient>;

export async function runCloseoutPayout(service: Service) {
  const token = crypto.randomUUID();
  const claimed = await service.rpc("wayne_claim_bank_payout", { worker_token: token });
  if (claimed.error) throw new Error("Bank payout queue could not be loaded.");
  if (!claimed.data) return { processed: false };
  let { batch } = claimed.data as { batch: PayoutBatch; items: PayoutItem[] };
  const { items } = claimed.data as { items: PayoutItem[] };
  const started = Date.now();
  const update = async (action: string, details: Record<string, unknown>) => {
    const result = await service.rpc("wayne_update_bank_payout", { target_id: batch.id, worker_token: token, action, details });
    if (result.error || !result.data) throw new Error("Bank payout progress could not be saved. The saved request will be reconciled.");
    return result.data as PayoutBatch;
  };
  try {
    const { data: connection, error } = await service.from("payment_connections").select("workspace_id,location_id,provider,status,environment,secret_reference").eq("id", batch.connection_id).maybeSingle();
    if (error || !connection || connection.workspace_id !== batch.workspace_id || (connection.location_id && connection.location_id !== batch.location_id)
      || connection.provider !== "stripe" || connection.status !== "connected" || connection.environment !== batch.environment) throw new PayoutReview("The store's Stripe connection needs review before payout.");
    const secrets = stripeSecrets(connection.secret_reference);
    if (!secrets || secrets.secretKey.startsWith("sk_live_") !== (batch.environment === "production")) throw new PayoutReview("The store's Stripe credentials need review before payout.");
    const stripe = createCloseoutStripe(secrets.secretKey);
    const account = await stripe.account();
    if (account.id !== batch.account_id) throw new PayoutReview("The connected Stripe account has changed. Review the closeout payout.");

    // An existing or ambiguous submission is reconciled before checking current
    // account settings or recalculating anything. The plan is immutable.
    let payout = await stripe.find(batch);
    if (!payout) {
      const bank = account.banks.find((b) => b.id === batch.bank_id && b.currency === "usd" && b.object === "bank_account" && !["errored", "verification_failed"].includes(b.status));
      if (!account.payouts_enabled || account.settings.payouts.schedule.interval !== "manual" || (batch.environment === "production" && !bank)) throw new PayoutReview("Stripe needs payouts enabled, a linked bank account and a manual payout schedule.");
      if (!batch.submitted_at) {
        const transactions: BalanceTransaction[] = [];
        let waiting: string | null = null;
        // Five reads at once, persisted individually, allow large days to make
        // progress across bounded worker runs without holding a request open.
        for (let offset = 0; offset < items.length; offset += 5) {
          if (Date.now() - started > 35_000) throw new PayoutWaiting("Checking the day's card settlements. The remaining payments will be checked automatically.");
          const results = await Promise.allSettled(items.slice(offset, offset + 5).map(async (item) => {
            const transaction = await stripe.transaction(item);
            if (transaction) {
              if ((item.kind !== "refund" && transaction.amount < 0) || (item.kind === "refund" && transaction.amount > 0)) throw new PayoutReview("A settlement amount has the wrong sign. Review before payout.");
              await update("item", { item_id: item.id, transaction });
              transactions.push(transaction);
            }
          }));
          for (const result of results) if (result.status === "rejected") {
            if (result.reason instanceof PayoutWaiting) waiting = result.reason.message;
            else throw result.reason;
          }
        }
        if (waiting) throw new PayoutWaiting(waiting);
        const totals = payoutTotals(transactions);
        const { data: carryRows, error: carryError } = await service.from("closeout_bank_payouts").select("net_cents")
          .eq("workspace_id", batch.workspace_id).eq("account_id", batch.account_id).eq("environment", batch.environment).eq("state", "no_payout").lt("net_cents", 0).is("offset_payout_id", null);
        if (carryError) throw new Error("Refund carry could not be checked.");
        const carry = (carryRows ?? []).reduce((sum, row) => sum + Number(row.net_cents), 0);
        const plan = { ...totals, carry_net: carry };
        if (totals.net + carry <= 0) {
          // Save exact totals even for a fully refunded / refund-only closeout.
          batch = await update("plan", plan);
          await update("finish", { state: "no_payout", message: totals.net < 0 ? "Refunds and fees exceed card sales. No bank payout was requested for this batch." : "No card proceeds remain after refunds and fees. No bank payout needed." });
          return { processed: true, state: "no_payout" };
        }
        if (await stripe.available() < totals.net + carry) throw new PayoutWaiting("Waiting for enough available Stripe card funds after refunds and account adjustments.");
        batch = await update("plan", plan);
      }
      payout = await stripe.create(batch);
    }
    verifyPayout(batch, payout);
    if (!["pending", "in_transit", "paid", "failed", "canceled"].includes(payout.status)) throw new PayoutReview("Stripe returned an unexpected payout status.");
    await update("finish", { state: payout.status, payout_id: payout.id, arrival_date: new Date(payout.arrival_date * 1000).toISOString().slice(0, 10),
      message: payout.status === "paid" ? "Stripe reports this bank payout paid." : ["failed", "canceled"].includes(payout.status) ? "Stripe could not complete this bank payout. Review Stripe before retrying." : "Standard bank payout requested. Waiting for bank processing.", retry_seconds: 900 });
    return { processed: true, state: payout.status };
  } catch (cause) {
    // Uncertain Stripe/DB outcomes retain submitting + the frozen plan. We
    // reconcile them on retry; never turn a timeout into a fresh transfer.
    const review = cause instanceof PayoutReview;
    await update("finish", { ...(review ? { state: "review" } : {}), message: review || cause instanceof PayoutWaiting ? cause.message : "The payout check could not finish. It will be reconciled automatically before any retry.", retry_seconds: 300 });
    return { processed: true, state: review ? "review" : batch.state };
  }
}
