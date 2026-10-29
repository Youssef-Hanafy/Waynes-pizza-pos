# P0: concurrent tip adjustment — engineering review

Scope: one defect, on `codex/stabilize-tip-adjustment`. No deployment, production migration, production data change, or production settings change was performed. This does not address the Elo screen/version, caller-ID, customer tip-prompt, signature, or other audited defects.

## Baseline and release identity

- Clean starting commit: `a2035a0a3cd2adfe84b1f13e368f9066375895e9`.
- The read-only `/api/version` responses from `app.hanafymedia.com` and `waynes-pizza-pos.vercel.app` identified `dpl_HoiQny3guq9948WYfLcAtFfhhNDW`. Its Git SHA, immutable deployment URL, build environment and correspondence to the checkout are **not verified**. A matching deployment ID alone does not prove that the Elo loaded that version.
- [Baseline manifest](tip-adjustment-baseline.json): all 87 existing migration names and SHA-256 checksums, deployment observation, and expected PostgreSQL major version 17. All baseline migration hashes remain unchanged. The checkout already contains migration names dated through November 6; the new migration follows that existing ordering. Names are not evidence of when production applied them.
- Previous audit baseline: 104 Vitest files / 616 tests passed; lint, typecheck and build passed. Relevant existing coverage includes database foundation, POS/order persistence, payments/connectors, delivery, drawer, tenancy/RLS, printing and offline/draft synchronization. There was no regression test of concurrent `captureHeldCards` calls against independent database connections.
- The new migration requires the existing `payments`, `orders`, tenant tables and `wayne_pos_apply_card_tips(jsonb,text)` function. It adds two tables and four service-only RPCs. It neither rewrites historical migrations nor backfills historical Stripe outcomes. Production migration history, schema drift, default privileges, backups/PITR and scheduler extensions still need verification against an approved nonproduction copy before a release.

## Root cause and evidence

Tips and driver cash-out constructed replacement-charge keys from different screen prefixes; cron could capture the original authorization while a replacement was being charged. There was no shared durable reservation. A successful replacement followed by a failed database pointer write could also leave the original payment eligible for another replacement. Stripe success and local ledger completion were separate steps, and tip webhooks were deliberately ignored. Recording a webhook before applying it also meant a failed application was discarded as a duplicate on retry.

The three initial regressions were written and run before changing application code. Each asserted one successful charge and observed **two**:

1. Tips racing driver cash-out.
2. Tips replacement racing scheduled original capture.
3. Lost successful replacement response, retried through another screen.

[Original failing output](tip-adjustment-red.log) records 3 assertion failures. An earlier fixture issue was corrected before this recorded run; these are financial-invariant failures, not setup failures. The test provider retains the legacy `chargeSavedCard` shape for baseline reproduction; the corrected implementation uses separate prepare/confirm methods. The same three behavioral assertions now pass, along with the additional failure/recovery cases.

## Correction and invariants

1. A unique `pos_tip_operations.payment_id` owns the operation, independent of screen/job origin. PostgreSQL transaction advisory locks, row locks, a 90-second lease and worker tokens serialize reservations and fence stale state writes. No SQL transaction is held open during a Stripe network request.
2. The operation freezes the authorized amount, requested tip and provider plan. Keys derive from the operation UUID and action. A changed amount on retry cannot create another financial operation. Tips can still be corrected following a read-only preflight failure; once a plan is accepted, a conflicting retry reports the actual recorded tip rather than silently applying a new amount. Post-capture tip amendment is not introduced by this change.
3. A replacement is created **unconfirmed**. Its ID must be committed in PostgreSQL before confirmation. Workers always resume that ID. A lost create response or expired creation key can leave an unconfirmed orphan, but the worker that cannot bind it cannot confirm it. A lease expiry does not permit a different charged intent.
4. A successful provider outcome is validated against the saved ID and exact amount. The payment pointer, order tip/total, payment status, audit event and operation receipt commit in one database transaction. A failure anywhere leaves a recoverable pending operation. A lost response after commit is recovered from the receipt.
5. Original hold release happens only after this transaction is acknowledged. Release failure remains durably pending; later recovery retries release, not the charge. Unknown, processing and action-required replacement outcomes never cause original capture/release. A definite failed replacement must be successfully canceled before fallback to the original authorization.
6. Signed tip-success webhooks can complete the same operation, scoped to the connection's workspace. Exact provider ID and amount must match. Repeated deliveries are idempotent; both Stripe webhook routes retry verified tip events even if the event row was previously recorded. Non-tip duplicate behavior is unchanged.
7. The existing nightly endpoint also loads pending operations and pending hold releases, including payments already marked captured. Recovery preserves the saved tip and targets the saved **payment ID**, not just the order. The schedule itself is unchanged; this is not a new continuous recovery worker.
8. `pos_tip_capture_control.execution_enabled=false` prevents newly claimed workers from initiating external capture/confirmation work, while allowing successful outcomes to be reconciled and recorded replacements' holds to be released. Workers already in flight must still be drained. The flag defaults to enabled in this additive migration; it is not a substitute for blocking old application versions.

Why a stable key alone is insufficient: Stripe may prune idempotency keys after at least 24 hours. Safety therefore relies on the persisted intent identity and Stripe's intent lifecycle, not unlimited key retention. Sources: [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests), [create an intent](https://docs.stripe.com/api/payment_intents/create), [confirm an intent](https://docs.stripe.com/api/payment_intents/confirm). Stripe itself remains a test-mode/manual validation requirement; local simulations are not proof of an acquirer outcome.

## File inventory

| File | Reason |
|---|---|
| `supabase/migrations/20261107080000_durable_tip_operations.sql` | Add durable operations/control tables; service-only claim, fenced update, atomic completion and webhook reconciliation functions; RLS and recovery index. |
| `src/lib/payments/tip-operation.ts` | Own the durable prepare/bind/confirm/reconcile/release flow and uncertainty handling. |
| `src/lib/payments/tip-capture.ts` | Keep the shared caller interface, select the intended payment and delegate to the coordinator; return durable receipts and actionable problems. |
| `src/lib/payments/provider.ts` | Replace combined saved-card charging with explicit unconfirmed creation and confirmation capabilities. |
| `src/lib/payments/stripe.ts` | Implement those two Stripe calls; reconcile succeeded amounts using `amount_received`. |
| `src/lib/payments/stripe-webhook.ts` | Reconcile verified tip-success events instead of discarding them. |
| `src/lib/payments/registry.ts` | Pass the verified connection workspace to Stripe reconciliation. |
| `src/app/api/webhooks/stripe/route.ts` | Replay verified tip duplicates after failed application and find their scoped event row. |
| `src/app/api/payments/webhooks/[key]/route.ts` | Apply the same retry behavior to per-connection Stripe webhooks. |
| `src/app/api/pos/tips/route.ts` | Report the already committed receipts; remove the now-redundant second ledger application and preserve exclusion of test-order tips from totals. |
| `src/app/api/pos/tips/auto/route.ts` | Resume pending operations/releases with their saved payment and tip; remove redundant ledger application. |
| `tests/helpers/tip-postgres.ts` | Create an isolated real PostgreSQL 17 cluster; replay migrations and run RPCs through independent database sessions. Never accepts an environment database URL. |
| `tests/tip-adjustment-concurrency.test.ts` | Initial red regressions plus real SQL concurrency, fencing, atomic failure, retries, cash-out and preserved behavior checks. |
| `tests/tip-adjustment-routes.test.ts` | Verify duplicate webhook retry/signature gates, scheduler recovery selection/authentication, and Tips response totals. |
| `tests/tip-adjustment-stripe.test.ts` | Verify create-without-confirm, confirm-by-ID, stable request keys, amount mapping and timeout classification at the HTTP boundary. |
| `package.json`, `package-lock.json` | Pin development-only `embedded-postgres`, `pg` and `@types/pg` for real PostgreSQL tests. No application dependency upgrades. |
| `docs/stabilization/*` | Baseline manifest, original red evidence, final validation evidence and this implementation/cutover/rollback report. |

The driver cash-out route and its existing SQL are unchanged: they already handle a captured card by paying out the order's recorded tip. A real database regression verifies exactly one tip addition, exactly one drawer payout, and no second payout on cash-out retry. No Android, UI-layout, offline, caller-ID or printing implementation was edited.

## Validation and limitations

See [final validation evidence](tip-adjustment-validation.txt) for command output. `npm run verify` completed with exit 0: lint, typecheck, all Vitest tests and the production build passed. The final total is 107 files / 660 tests, including 44 new tests. Initial red evidence is retained separately.

The new real PostgreSQL suite covers independent backend PIDs and a claim blocked until the competing transaction commits, three entry points racing, stale lease takeover during a delayed confirmation, network response loss, unconfirmed create response loss, key expiry simulation, a failed bind before confirmation, database failure before completion, an actual trigger failure during the order write, response loss after commit, repeated/concurrent webhook reconciliation, wrong workspace/amount, unexpected captured amount, processing/action-required outcomes, decline/cancel/fallback ordering, uncertain cancellation, release retry, test cards, overcapture, preflight tip correction, direct-RPC privilege denial, and the maintenance switch. Stripe transport remains simulated; database locks/transactions are real, not mocked.

`npm run test:db` was attempted and failed before any tests ran: no local Supabase PostgreSQL was listening at `127.0.0.1:54322`. Docker/Supabase is not running here. This is **not a passing pgTAP result**. The separate real-PG suite runs in a temporary cluster and does not replace verification of hosted Supabase/PostgREST behavior.

`E2E_RUN_STAGING=0 E2E_BASE_URL=http://127.0.0.1:3000 npm run test:e2e` discovers the existing browser acceptance test and correctly skips it. No isolated staging credentials/browser session were supplied. This is **not a passing browser acceptance result**.

The PostgreSQL harness never reads `.env` URLs and only listens on loopback. Test clusters are removed on normal shutdown. The pinned PostgreSQL npm distribution requires its package installation scripts; package managers that block those scripts must explicitly approve the platform binary package's symlink hydration before running these tests. The local macOS ARM64 binary hydration was run after inspecting its script; no OS account or persistent database service was installed.

Known limits requiring review:

- Existing ambiguous/duplicate charges created by older deployments are not repaired or automatically adopted. Inventory and reconcile them before enabling the new path. This migration does not prove there are no historical double charges.
- No safe claim can cover old deployed code that ignores the new coordinator. Mixed-version financial writers must be excluded at cutover and rollback.
- An action-required intent, canceled original, missing saved card, permanently unavailable provider, or conflicting amount/ledger requires operator reconciliation; the code does not charge an alternate card automatically. Do not collect cash again merely because an outcome is pending.
- A changed tip after a plan was accepted is not a new charge request. Staff see the recorded amount and a conflict message. Confirm this retry behavior with staff in staging; a separate post-capture adjustment workflow would require its own design and approval.
- The existing nightly schedule and 60-second endpoint budget are unchanged. Webhooks/retries provide additional recovery, but pending items can wait until the next job; backlog size, cron delivery, authorization expiry and pending hold-release age need operational review. Never infer that an empty tip queue means all releases succeeded: inspect operations too.
- Explicit administrative void/refund actions and out-of-band Stripe Dashboard actions are outside this concurrency test matrix. Do not perform them on an unresolved operation without reconciling its saved IDs. Rehearse those operational procedures in staging.

## Cutover and rollback runbook — proposed only, not executed

The additive schema and a tested stop/reconcile path provide a viable containment strategy. A production rollback is **not yet operationally validated** because deployment-to-SHA mapping, backup/restore access and a staging rehearsal are outstanding. No production release is proposed as part of this change.

Before any later approved release:

1. Identify and retain the exact currently deployed artifact, Git SHA, environment/Stripe account mapping and database migration history. Verify restorable backups/PITR in an isolated environment. Compare the baseline manifest with live migration history; resolve drift, do not blindly replay migrations.
2. Rehearse migration, new/old application compatibility with capture disabled, stop/reconcile and rollback in staging. Run the existing pgTAP and browser suites there, plus the Stripe/Elo checklist below. Retain both deployment artifacts. No destructive down migration is needed.
3. Block external writes to `/api/pos/tips` POST, `/api/pos/delivery/cashout` POST and `/api/pos/tips/auto` across all serving/old deployment URLs. Pause the scheduler during cutover. Preserve webhook delivery or arrange replay. Drain every old in-flight worker and reconcile legacy ambiguous replacements against Stripe before new writers are admitted. A database stop flag cannot stop the old code.
4. Apply the additive migration during that controlled pause. Set the new execution flag false while validating the application/schema pairing. Verify service-only permissions, deployment identity, provider account and pending-operation visibility. Deploy the approved build only when authorized. Enable the new workers and resume the scheduler only after the old writers are inaccessible. The flag and deployment actions here are instructions for a future release, not actions performed in this task.

If a staging/release problem appears:

1. Block the three write entry points and pause cron; disable new execution via `pos_tip_capture_control`. Allow in-flight requests to finish or expire, then inspect each pending operation and its exact original/replacement IDs. The flag is read at claim time, so changing it is not instantaneous cancellation of an in-flight Stripe request.
2. Keep a coordinator-compatible build and verified webhooks available for read-back/completion while money movement is paused. Reconcile succeeded charges, retain uncertain operations, and release original holds only after the saved receipt commits. Confirm the operation table, order/payment ledger and Stripe agree. Never delete operation rows to make a retry work.
3. Retain both tables, all receipts and all provider IDs. Do not restore a database snapshot over newer financial transactions; that would erase charge history. Use backups for disaster recovery with provider reconciliation, not as an ordinary code rollback.
4. Prefer rolling back unrelated presentation code while retaining this coordinator, or keep capture paused until a corrected coordinator build is ready. Re-enabling the baseline's capture code would reintroduce the demonstrated double-charge defect even if the schema is retained. A plain `git revert` followed by resumed capture is **not** a safe rollback.

## Required staging / manual evidence

- **Elo:** model/serial identifier, Android OS and WebView version, POS APK package/version/build, actual loaded URL and `/api/version`, native bridge/reader version, network state, and one incident's local timestamp/order/payment IDs. Collect APK/deployment identity from the actual register, not a desktop browser.
- **Stripe test mode:** verify the account/API version and webhook endpoint/signing configuration; create a real test authorization with the saved generated card/customer. Exercise zero tip, supported overcapture, replacement, decline, action-required, simultaneous Tips/cash-out/cron, lost/delayed responses and replayed webhooks. Verify exactly one captured payment, the intended tip and cancellation of the original authorization after reconciliation. Verify both webhook URLs used by the environment.
- Kill the application after provider success and before local completion; restart another instance and confirm the same saved replacement ID is reconciled. Repeat after a database write failure and after a lost commit acknowledgment. Exercise the stop/reconcile runbook and pending release recovery.
- On an Elo using **staging only**, verify Tips totals, driver cash-out totals/drawer payout, receipt output, screen reload and retry messages. Confirm unrelated working order entry, terminal payment, signature/customer-display and printing behavior. These are manual acceptance checks, not claims that the other audited bugs are fixed.

Disposition: suitable for isolated staging/code review once the final local checks pass; **not production-release ready** until the above blocked checks, manual verification and rollback rehearsal are complete. Stop here after this one defect.
