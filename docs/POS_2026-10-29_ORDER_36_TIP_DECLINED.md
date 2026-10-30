# Order #36 (W001228): "Declined" at cash-out, tip charged separately (2026-10-29)

Investigation was read-only on production. No Stripe payment or database row was retried, captured, refunded or changed.
The fix is on branch `dev/keyed-tip-separate-charge`. It is not merged, not pushed and not live.

## What happened

| Time (ET) | What | Evidence |
|---|---|---|
| 7:06 PM | Phone delivery, keyed Visa ••3289 **approved** (held, not charged) for $46.03 | payments row `53ae2b3b…`, `pi_3UW2PLFk…`, status authorized at 23:06:57 UTC |
| 7:58 PM | Out with Mohammed | order_events `delivery.assigned` |
| 9:55 PM | Driver cash-out, $3 tip typed | order_events `delivery.cashed_out` |
| 9:55 PM | POS asked Stripe for a **new $49.03 charge** (order + tip) → **refused** | metadata: `tip_charged_separately: true` (only set after that charge is refused); no `charged_with_tip` / `replaced_intent` |
| 9:55 PM | Fallback: **$3 tip charged alone** → succeeded | `tip_charge_intent: pi_3UW52EFk…`, `tip_charge_cents: 300` |
| 9:55 PM | **$46.03 captured on the original approval** → succeeded | payment captured 01:55:22 UTC, order paid, `tip_cents` 300, total 4903 |

**Was a $49.03 charge tried and declined first? Yes.** The code only reaches the tip-alone charge after the $49.03 charge (key `driver-cashout-recharge-53ae2b3b-6192-4342-8971-722efa62b5f1-4903`, description "#36 with tip") came back refused.

**Why it was refused.** Wayne's Stripe pricing can't add a tip onto a keyed (card-not-present) approval. Stripe confirmed this on 10/28, and again in today's chat for acct_1UL5E5FkKfwmBcsh. So the code made a new order + tip charge while the $46.03 hold was still on the card. That needs about $95 free on the card. The exact bank reason is only in Stripe: Payments → Failed → $49.03, 9:55 PM. That's because `stripeError()` turns every card error into "The card was declined. Try another card." The likely reason is insufficient funds, the same as on 10/27.

**Why the POS said "Declined".** The cash-out result listed this line in the yellow warning box: "#36: the card didn't have room for order + tip together (The card was declined. Try another card), so the $3.00 tip went through as its own charge. All paid." The order was fully paid. The warning just repeated Stripe's decline from the refused $49.03 attempt.

## Decision (Youssef, 2026-10-29)

The tip is charged **separately** from the order. No combined order + tip charge on keyed cards. Report and fix only, no live changes.

## The fix (branch `dev/keyed-tip-separate-charge`)

`src/lib/payments/tip-capture.ts`, for a held card with no room for the tip on its approval (every keyed delivery card):

1. The $49.03-style "order + tip" recharge and the hold-release step are removed.
2. **Tip first, alone** on the saved card. Only the tip needs to be free. It uses the same idempotency key as the 10/28 fallback, so a tip charged by the old code is never charged again.
3. **Order on its approval** (it can't be declined). One result, no warning, nothing that reads as "declined".
4. **If the tip is refused:** nothing is charged, the card stays on the run with the tip typed in, and the message names the slip and the reason. This keeps the 10/28 rule that a tip is never silently dropped.
5. **New guard:** if a tip was already charged on its own and the typed tip is now different (or 0), stop and charge nothing more. Before this guard, editing the tip to 0 on a retry would have dropped the recorded tip.

Unchanged: Reader M2 / any card with overcapture room (one capture for order + tip), the 4:30 am safety net (tip 0, order only), the counter card, cash and drawer, pickup keyed cards (charged on the spot), Pay later, add items, slips, close out. None of these call this code, or they take a path this change doesn't touch.

## Checks

- Fake-Stripe run of the compiled file, 9/9 passed: #36 shape ($3 alone, then $46.03, never $49.03, no warning); tip refused; no answer on tip; retry after tip went through; tip edited after a separate tip; lost answer on order capture; tip 0; M2 with room; tip charge returned "failed".
- The same cases are in `src/lib/payments/tip-capture.test.ts` for `npm test`. This session couldn't install packages (registry unreachable), so **run `npm test` and `npm run typecheck` on the Mac before merging.**
- The recorded result (payments.amount_cents = order + tip, orders.tip_cents) uses the same shape that wrote #36 correctly in production. No database change is needed.

## Cost and follow-ups

- Each keyed delivery card with a tip is now two Stripe charges, so two fixed fees (e.g. $0.30 each on standard online pricing). Stripe will list them as two lines (`#36` and `#36 tip`). The POS shows one $49.03 payment.
- **Refunds:** the Admin refund goes against the order's charge only. The tip part of such an order has to be refunded in Stripe on the "#N tip" charge. This was already true since 10/28.
- Optional: keep Stripe's decline code (e.g. insufficient_funds) in staff-facing messages, so the next investigation doesn't need the Stripe dashboard.

## To ship (when you decide)

```
git fetch origin && git checkout dev/keyed-tip-separate-charge   # or: git am the patch onto main
npm test && npm run typecheck
git checkout main && git merge dev/keyed-tip-separate-charge && git push origin main
```
