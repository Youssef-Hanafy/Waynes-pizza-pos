# Menu pricing: independent implementation and staging review

Branch: `claude/menu-pricing-final`. Integrates `codex/menu-pricing-fix` at
`91d4dbb1ff7c21b875d5b7d6bdb0c201d76b663d`; latest fetched main remains
`4ccaac0ec388ada16e6e505598d798bb51306983`. The original handoff is
[MENU_PRICING_FIX.md](MENU_PRICING_FIX.md); its validation limits describe the
previous phase. This document records the subsequent hosted verification.

No production database, production application, existing customer order, main
branch, shared checkout, or operations branch was changed.

## Exact affected data and cause

| Product | Existing menu_items.id | Applicable field | Approved cents |
|---|---|---|---:|
| Cheeseburger Dinner | 418c30cc-344c-4200-917d-0d60c183c77c | base_price_cents | 1425 |
| Gyro Dinner | 5677ccf0-ba1d-41a1-8382-473233f61ea9 | base_price_cents | 1425 |

Workspace: `40000000-0000-4000-8000-000000000001`.
Category Dinners: `3fcd712d-f81a-45cf-9251-228af6584bdc`.
These are separate regular products, without variants or size-price overrides.
The owner supplied these production identifiers and their 1350-cent prices via
read-only SQL. No direct production access was used in this review.

Each product has an empty optional Meats modifier group. The old schema required
at least one choice even when no selection was required. Thus a price-only edit
through the full editor failed before a database write. We reproduced both
failures through real login, manager PIN, and submissions on the old staging app;
both database prices remained 1350. Required-group validation remains enforced.

## Improvements made during independent review

1. Prevent a mixed editor snapshot: read the parent revision before its children
   and again afterward; refuse editing if it changed during loading. Two new
   regressions failed before this fix and pass afterward.
2. Preserve included-count/portion allowances on ordinary full-item saves, which
   recreate modifier groups. Validate submitted group ownership and follow stable
   variant IDs through size renames. Three actual PostgreSQL regressions failed
   before and pass after (allowance preservation, foreign group rejection, empty
   required-group rejection).
3. Keep modifier size-price overrides attached to stable draft keys during size
   renaming, including temporary duplicate names. Serialize with the final names
   only when submitting; a regression covers rename and removal.
4. Replace application conflict SQLSTATE `40001` with `PT409`, mapping to HTTP409.
   The real hosted concurrency test exposed a PostgREST retry loop that direct
   PostgreSQL tests could not reveal. Before this fix, the stale request never
   displayed an error. Afterward it promptly rejects the stale write and retains
   the unsaved draft. This is the documented
   [Supabase/PostgREST 40001 retry issue](https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions).
5. Pin the correction script to the exact workspace UUID as well as item/category
   IDs. It locks relevant tables, verifies uniqueness and active status, refuses
   unexpected variant prices or current prices, changes only the two base-price
   fields, and is transaction-safe and repeatable. Existing 1425 is a no-op.
6. Renumber the unshipped pricing migration to
   `20261124080000_menu_price_editing.sql`: the operations branch already uses
   `20261122080000`, and its verification branch uses `20261123080000`. Both
   remote branches were fetched and checked; no operations migration was edited
   or imported. The staging
   ledger was corrected to the unique pricing version.
7. Add a guarded synthetic staging-fixture preparer, real hosted browser tests,
   and a management-API pgTAP runner. Credentials, session files and browser traces
   stay ignored locally; none are included in the review evidence.

Inherited fixes retained: exact integer cents, database-acknowledged saves,
price-only canonical updates, detailed inline failures, preserved drafts,
optimistic revision checks, admin/POS/public-menu invalidation, audit history,
duplicate size checks, and a legacy-import refusal before destructive writes.
Payments, customer checkout and register runtime implementation files are unchanged.

## Hosted environment and price correction

The owner confirmed shared staging availability. All hosted writes targeted
Supabase project `pkjrdvtdygiprmsojdqg` (`waynes-pos-staging`) and Vercel project
`prj_Bg0RzItCkAPgzTaWM71M98RY2PiV` (`waynes-pos-staging`). Vercel calls its stable
staging environment “Production”; this is not `app.hanafymedia.com`.

The preparer created synthetic dinner rows with production-shaped IDs and child
configuration, marked explicitly as staging fixtures, plus dedicated synthetic
reviewer accounts. Existing shared fixtures were retained. Before correcting
prices, real TEST POS orders were saved at 1350 cents for historical checks.
The pricing migration and guarded correction were applied only to staging;
repeating the correction left both prices and revisions unchanged.

## Validation

Evidence is stored under `menu-pricing-final-validation/`. Runs use synthetic
prices and records; no live restaurant prices or financial transactions were used.

- Full regression suite: 137 files, 891 tests passed.
- ESLint, TypeScript and production build: passed.
- Isolated PostgreSQL/Chromium pricing flows: three passed, including injected
  database failure and draft retention.
- Hosted pgTAP: 67 assertions across five pricing/menu/permission/tenancy files
  passed in rolled-back transactions on PostgreSQL17.11.
- Old hosted app: both full editor submissions reproduced the empty-choice error.
- Candidate hosted app: real owner login/PIN; price-only save to 1426 cents, reload;
  full-item save to 1425 cents, reload/reopen; both real POS dialogs at $14.25; real TEST
  POS order-line snapshots at 1425 cents; both public menu cards at $14.25; historical snapshots
  remain at 1350 cents. Cashier denied in both admin UI and authenticated RPC. Separate
  browser registers reject a stale 1350-cent submission and preserve its draft.

Public Stripe sandbox checkout also passed through the actual browser/card form
and confirmation endpoint: a saved online order contains both dinner IDs with
`unit_price_cents = 1425`. Only a test publishable key, sandbox connection and Stripe
test card were used. The customer-display checkout regression passed ownership
reclaim, a dropped heartbeat, delayed tip persistence, injected signature-save failure and retry,
and exactly one simulated payment. Tips were enabled only for that staging test
and restored to their original false setting afterward.

The hosted test separates the anonymous online customer from the staff session.
The before-install baseline is deliberately skipped on a candidate run and was
executed separately against the original staging app. Local browser traces remain
private because they include synthetic sign-in sessions.

One interrupted sandbox checkout left a pending payment; the release guard
correctly refused an idle reload. The same synthetic order was then completed
through checkout with its original idempotency key, and pending payments returned
to zero. No financial guard was bypassed or disabled. A subsequent controlled
release-transition check passed: the open draft blocked the update; after staff
returned to idle, the browser loaded and verified the new build with exactly one
reload and no loop. The other two hosted screen-stability checks passed as well.

Browser coverage is Chromium, including real Supabase sessions and PostgreSQL;
physical Elo restart, hardware card-reader and production acceptance remain outside
this review. The unrelated phase0-5 live refund/core-path browser file was not
rerun; the full automated regression suite and each browser run are listed here.

## Exact staged release and final results

Staging URL: https://waynes-pos-staging.vercel.app

Tested implementation commit: `3ea712aa4976befb03c7efed62f1387470053e7b`.
Staging build: `dpl_jzYseKuqbD8itfnJnG51vGo47vAP`.
The final handoff commit adds review evidence and documentation to that tested
implementation; application code and database migration contents are unchanged.

| Final check | Result |
|---|---|
| Full automated suite after migration renumber | 137 files / 891 tests passed |
| Hosted PostgreSQL / RLS / tenancy / pricing | 67 assertions passed |
| Local isolated PostgreSQL + Chromium | 3 tests passed |
| Hosted pricing + public Stripe sandbox checkout | 4 candidate tests passed; before-install baseline skipped deliberately |
| Hosted original-app baseline | Both dinner save failures reproduced in the separate baseline test |
| Hosted customer-screen checkout | 1 test passed; exactly one simulated payment, tip/signature recovery |
| Hosted screen ownership and safe draft retention | 2 tests passed |
| Controlled real staging release transition | 1 test passed; exactly one confirmed idle reload |
| TypeScript, ESLint, production build | Passed |
| Production mutation / main merge / production deployment | None |

The earlier release-transition failure in the saved screen log is the correctly
blocked pending sandbox payment, resolved by the checkout retry described above.
The later release-transition log and confirmed journal show the passing final run.
A subsequent attempt waited in Vercel's account build queue beyond the browser
coordination deadline; no runtime or financial guard was changed for that delay.
Final acceptance reran all four hosted pricing tests against that exact staged
commit after the release transition; all passed. The final database read confirms
both base prices at 1425 cents, the two historical order lines at 1350 cents, four new POS/online
lines at 1425 cents, zero pending payments, and the original tips setting restored.

## Production release boundary

Independent review and explicit production approval remain required. This work
has not changed production prices. After approval, apply the unique pricing
migration, deploy the reviewed application, then run the separately approved
`scripts/correct-dinner-prices.sql`; reload an idle register and verify both IDs.
Older editor clients without a revision must reload before saving. Offline
registers need connectivity and a menu refresh to receive remote changes.
No order or payment table is updated by the pricing migration or correction.
Do not run the legacy importer. Re-fetch main and reconcile with operations work
before integration; no merge or production deployment is authorized here.
