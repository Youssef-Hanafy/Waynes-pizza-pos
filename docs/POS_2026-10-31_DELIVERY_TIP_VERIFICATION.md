# Verification: delivery tip before payment (Issue #5), 2026-10-31

- **Verified:** `ef24ec9` (`claude/pos-operations-fixes`).
- **Fixes:** branch `claude/pos-operations-fixes-verification`. `7f34fb7` holds the fixes; the next commit adds this report.
- Not merged and not deployed. No database was changed: no staging, no production.

## Verdict

- **Code and database: PASS, after three fixes.**
- **Release: NOT READY until the staging + Stripe sandbox run below is done.** This session could not reach staging Supabase (`pkjrdvtdygiprmsojdqg` isn't in the connected Supabase account), `waynes-pos-staging.vercel.app`, `api.stripe.com`, npm, Vercel or the GitHub API. So there is no real-Stripe or browser evidence yet, and none was invented.

## Defects found in ef24ec9 and fixed

Each fix has a regression test that fails on ef24ec9 and passes on the fix commit.

| # | Defect | Impact | Fix |
|---|---|---|---|
| 1 | **Lost answer → order stuck.** The register re-sends the on-screen tip before every approval. After a lost answer, the retry was refused by ef24ec9's own pending-payment lock, and `wayne_begin_payment` refused a second approval. | The order could not be paid by any method (cash also refuses an open payment). | `wayne_pos_set_tip` answers a **same-tip** re-send as a no-op; a different tip is still refused. `keyed-card/intent` resumes a keyed card left open longer than the register waits (20 s). It continues the **same** payment and PaymentIntent, for the same amount only, using the original idempotency key if its Stripe id was never saved. A card another register opened moments ago is not taken over. An already approved card is only read back. |
| 2 | **Refund of phone tip + separate extra.** ef24ec9 makes a payment possible that holds a $5 tip inside the original $35 **and** a $3 extra charged on its own. `wayne_begin_allocated_refund` sent the whole $8 tip leg to the $3 charge. | Stripe refuses that leg, so a full refund is left half done. | The separate charge refunds at most what it charged; the rest of the tip comes off the original. With no phone tip the legs are exactly as before (the 21 existing refund tests pass unchanged). |
| 3 | `keyed-card/confirm` settled whatever Stripe reported. | A Stripe amount different from the ticket would have been booked as if it matched. | It refuses (409 `AMOUNT_MISMATCH`) and books nothing. |

The fixes are in migration `20261123080000_delivery_tip_verification_fixes.sql` (re-runnable, no data change), `src/app/api/pos/keyed-card/{intent,confirm}/route.ts` and `payments-screen.tsx` (an approved card that was resumed isn't confirmed twice).

## Financial reconciliation

All on real PostgreSQL with every migration applied. The Stripe provider is simulated in-process and records every money movement.

| Scenario | Stripe moved | Payment | Order tip / total | Driver paid | Extra tip charges |
|---|---|---|---|---|---|
| $30 + $5 phone tip, cash-out with Extra blank | **one** capture of $35.00 on the original PaymentIntent | $35.00 captured, `tip_included_cents` 500 | $5.00 / $35.00 | **$5.00** once (drawer paid_out) | **0** |
| Same, cash-out retried | nothing more (capture called once) | unchanged | unchanged | unchanged | 0 |
| $5 phone tip + $3 extra on the slip | $35.00 capture + $3.00 separate tip | $38.00 | $8.00 / $38.00 | $8.00 | 1 ($3.00) |
| No phone tip, $5 on the slip (unchanged path) | $30.00 + $5.00 | $35.00 | $5.00 / $35.00 | $5.00 | 1 |
| 4:30 am safety net on a pre-tipped card | $35.00 once | $35.00 | $5.00 / $35.00 | (not cashed out) | 0 |
| $3 extra declined by Stripe, then $0 extra | nothing, then $35.00 | held, then $35.00 | $5.00 / $35.00 | n/a | 0 |
| Lost Stripe capture answer | $35.00 once (read back from Stripe) | $35.00 | $5.00 / $35.00 | n/a | 0 |
| Tips + cash-out ($3) + safety net racing | one operation; charged = payment = order total ($35.00 or $38.00) | matches | $5.00 + the operation's extra | n/a | ≤ 1 |
| Full refund after $5 phone tip + $3 extra | legs: $35.00 on the original, $3.00 on the tip charge (tips 800 total) | — | — | — | — |

Concurrency, on independent PostgreSQL backends:
- **Tip change vs. approval:** 12 races; no open approval's amount ever differed from the order total.
- **Both registers pressing Approve at once:** exactly one payment ($35.00).
- **Same-key replay:** the same payment comes back; no second payment is created.

## Test results

Each file ran in its own process under Bun 1.4.4 on system PostgreSQL 16, standing in for embedded-postgres, `pg` and PGlite. These are local, uncommitted shims, because the npm registry is blocked here.

| Branch | Pass | Fail | Notes |
|---|---|---|---|
| main `4ccaac0` | 752 | 77 | |
| `ef24ec9` | 783 | 77 | +31 new, all pass |
| fix commit `7f34fb7` | **803** | **77** | +20 verification tests, all pass |

The 77 failures are the **same files with the same counts on all three**. They are harness limits:
- jsdom / browser stores: `ringing-banner`, `customer-display-link`, `pos-history`…
- vitest-only `vi.mock` hoisting: `tip-adjustment-routes`, `tip-adjustment-stripe`, `refund-recovery`, `update-*`
- PGlite-only behaviour: 2 tests in `phase4-database` and 3 in `phase7-database`

Payment suites passing on the fix commit:

| Suite | Result |
|---|---|
| tip-adjustment-concurrency | 34/34 |
| tip-separate-keyed | 6/6 |
| stripe-reconciliation | 22/22 |
| refund-allocation-postgres | 21/21 |
| tip-drafts | 6/6 |
| migration-integrity suites | all |

**Typecheck:** every changed file, with real `@types/react` and zod source and stubbed Next/Supabase types, shows no new errors versus main.

**Not run here:** `npm run lint`, the full `tsc` with the real Next/Supabase types, `next build`, Playwright, staging, Stripe sandbox. Route files export only `POST`, as Next requires.

## To finish the release gate (staging + Stripe sandbox)

1. On staging only, apply `20261122080000_delivery_tip_before_payment.sql` then `20261123080000_delivery_tip_verification_fixes.sql`. Deploy `claude/pos-operations-fixes-verification` to the staging Vercel project.
2. Run `npm ci && npm run verify && npm run test:e2e`.
3. On the staging POS: phone delivery $30.00 → Key in card → **＋ Add tip** $5 → approve `4242 4242 4242 4242` → send out with a driver → Deliveries shows "$5.00 tip already on the card" → cash out with Extra blank.
4. Wait a minute (Stripe search lags), then run:
   `node scripts/verify-delivery-tip-staging.mjs <order-id> 3000 500 0`
   It needs `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_SERVICE_ROLE_KEY` and `STRIPE_SANDBOX_SECRET_KEY`. It is read-only and refuses production and live keys. **PASS** means:
   - exactly one approved PaymentIntent for $35.00, with `wayne_tip_cents=500`
   - one captured charge of $35.00, and no other approved or charged intents
   - order, payment and driver tip all agree
5. Repeat with:
   - a $3 extra (`… 3000 500 300`: expect $35 + a separate $3, driver $8)
   - decline card `4000 0000 0000 0002`, then change the tip and approve
   - a register reload mid-approval (resume)
   - two registers on one order
