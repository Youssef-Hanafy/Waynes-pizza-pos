# Issue #5: delivery tip before payment (2026-10-31)

Branch `claude/pos-operations-fixes`, cut from `main` 4ccaac0. **Not merged, not deployed.** One database migration, which has not been applied anywhere yet (staging first).

## What the owner asked for

A customer calls in a delivery, pays with a card over the phone and wants to tip the driver right away:

| Step | Result |
|---|---|
| Delivery order | $30.00 |
| Cashier taps **＋ Add tip**, picks $5 | Screen shows **$35.00** at once: order $30.00 + $5.00 driver tip |
| Card keyed in | Stripe gets **one** $35.00 PaymentIntent (approved, held for the driver's cash-out like every delivery card) |
| Driver cash-out | Nothing more is charged. The drawer pays the driver the $5.00 |

There are two separate workflows:

- **A. Tip before the card is approved:** one combined approval (new).
- **B. Tip from the signed slip after approval:** the existing durable tip operation at cash-out. It charges only the **extra** on top of the approval (unchanged, including the keyed-card limit: no overcapture, so an extra tip is charged on its own).

## Changes

| Where | What |
|---|---|
| `src/lib/pos/delivery-tip.ts` (new) | Pure rules: $ / % tip math (percent of the order before the tip), what the box shows and charges, and the attempt lock (`idle → authorizing → done`, a definite decline goes back to `idle`, no answer becomes `unknown`, which stays locked). |
| `src/app/pos/payments-screen.tsx` | Key in card on a delivery: a large **＋ Add tip** button. It opens $3 / $5 / $10 / 15% / 18% / 20% / other $ / other %, then closes again so the box still fits the screen. A charge summary shows Order / Driver tip / **Card is approved for**, and the big total at the top updates as the tip changes. The tip is saved on the order before the approval, every time (even $0), so the order holds exactly the tip on the screen. The tip is locked from the moment the approval starts. If Stripe's answer is lost, the button becomes **Check the card again** for the same payment and amount; it never re-keys the card or uses a new total. Test orders get the same tip step. The paid screen says "Order $30.00 + $5.00 driver tip — one approval". |
| `src/app/api/pos/keyed-card/intent/route.ts` | Takes `expected_amount_cents` / `expected_tip_cents` (what the cashier saw). A different amount is refused (409 `AMOUNT_CHANGED`) **before** a payment opens. If the order changes between that check and the payment opening, the payment is closed as failed before Stripe sees it. A replayed request may only continue the same amount. The tip inside the approval is written on the payment (`tip_included_cents`, `order_cents`) and on Stripe's record (`metadata.wayne_tip_cents`, `wayne_order_cents`, and the description says "order $30.00 + $5.00 tip"). Registers on the previous build (no expected amount) work as before. |
| `src/lib/payments/{provider,stripe,schemas}.ts` | Optional `tipCents` passed through to Stripe metadata; the schema fields above. |
| `supabase/migrations/20261122080000_delivery_tip_before_payment.sql` | `wayne_pos_set_tip` now also refuses while a payment is **pending** (approval in progress). Before, it refused only once a payment was authorized or captured, so the tip could still change mid-approval. A declined card settles as failed, which unlocks the tip again. The rest of the function is unchanged. Re-runnable. |
| `src/lib/delivery/pos-board.ts`, `src/app/pos/deliveries-screen.tsx` | Display only. A held card with a phone tip shows "$5.00 tip already on the card · extra only", and its box is labelled **Extra tip**. The run-down counts the phone tip in card tips (store pays the driver), and the Order / Total columns show it correctly. If the extra typed equals the phone tip (the likely double entry), a warning appears before Confirm. **The cash-out request, capture and `wayne_pos_driver_cashout` are unchanged.** |

### Why cash-out needed no change

The tip operation's tip is always on top of the approved amount (`captured − authorized`), and `wayne_pos_apply_card_tips` **adds** it to `orders.tip_cents`. A $35 approval with a blank extra is captured for $35 (one capture call, no separate tip), and the order keeps its $5 tip. `wayne_pos_driver_cashout` then sees the card as charged (`paid_by = 'card'`) and pays the driver `orders.tip_cents` = $5. With a $3 extra: the $3 is charged on its own (keyed card), the order tip becomes $8, and the driver gets $8. The real-Postgres tests below cover all of this.

Receipts were not touched. The customer receipt already prints Subtotal … Tip $5.00 · TOTAL $35.00 · PAID – CARD. The tip & signature slip already prints "Tip already added $5.00" and a blank "Extra tip:" line.

## Tests

| File | Covers |
|---|---|
| `tests/delivery-tip-before-payment.test.ts` (7, real PostgreSQL, full migration chain) | $30 + $5 → one $35 payment. Pending approval locks the tip and blocks a second approval; a decline unlocks it. No tip change after approval. Cash-out with no extra: one $35 capture, no separate tip, order tip $5, driver paid $5, retry moves no money. Extra $3 after approval: $3 separate + $35 capture, order tip $8, driver $8. No phone tip: unchanged behaviour. Board shows the tip on the held card. **The lock test fails without the migration.** |
| `tests/keyed-card-tip-before-payment-route.test.ts` (7) | One Stripe intent for $35 with tip metadata. Stale screen refused before any payment. Same total with a different tip refused. Race closes the payment before Stripe. Replay with a changed total refused. No tip on the rest of a partly paid order. Old client still works. **All 7 fail on the previous route.** |
| `src/lib/pos/delivery-tip.test.ts` (12) | Totals, $ / % parsing and rounding, ceilings, lock transitions. |
| `src/lib/delivery/pos-board.test.ts` (+5) | Phone tip in the cash-out lines and summary, extra-only box, repeated-tip warning, label, all other deliveries unchanged. |

### How it was run here

The npm registry was blocked in this session, so `npm ci` could not run. The suite ran with Bun 1.4.4 as the runner, zod from its GitHub source, and **system PostgreSQL 16** standing in for `embedded-postgres` / `pg` (local, uncommitted shims in `node_modules`). Every test file ran in its own process, on this branch and on `main` 4ccaac0:

- **No test result changed** except the new tests, which all pass: `tip-adjustment-concurrency` 34/34, `tip-separate-keyed` 6/6, `stripe-reconciliation` 22/22 and `refund-allocation-postgres` 21/21 pass on both.
- Suites that need PGlite, jsdom or vitest-only mock hoisting failed the same way on both branches. That is the environment, not this change.
- Type-check of every changed file (real `@types/react` and zod, stubbed Next/Supabase): no new errors versus `main`.
- **Not run here:** `npm run verify` (eslint, tsc, vitest, next build), Playwright, the Stripe sandbox, Supabase staging. Codex is verifying independently before release.

## To release (after Codex's verification)

1. Apply `20261122080000_delivery_tip_before_payment.sql` on staging, then run the acceptance below on https://waynes-pos-staging.vercel.app with the Stripe sandbox.
2. Acceptance: delivery $30 → Key in card → Add tip $5 → total shows $35 → approve with 4242… → the Stripe PaymentIntent is $35.00 with `wayne_tip_cents=500` → Deliveries shows "$5.00 tip already on the card" → cash out with the Extra box blank → one capture for $35, driver tip $5 on the tips slip. Repeat with $3 extra (separate $3 charge, driver $8), and with a decline (4000 0000 0000 0002), then change the tip and approve.
3. Production only after that. The migration is backward-compatible with the current build.
