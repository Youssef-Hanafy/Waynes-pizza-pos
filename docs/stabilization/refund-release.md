# Split refunds and production release procedure

This continues integrated commit 9985a0d on current main b73a114. Production has
not been changed. This document describes a separately approved future release.

## Refund policy and implementation

The owner selected: order amount first; tip refund only when explicitly entered;
record driver recovery due for refunded tips already paid out. The total refund
includes the entered tip component. A request exceeding the remaining order
amount without selecting its tip fails. A held authorization must be voided, not
refunded. Voids use the stored provider identity, reserve under the coordinator
fence, and resume the same cancellation after uncertainty. An active tip operation
must be reconciled first. Captured replacement and split payments preserve their original receipts.

Every Stripe refund is allocated transactionally before calling the provider. A
split uses one durable refund row for each intent. Pending and completed rows
reserve their amounts against concurrent requests. Duplicate requests reuse the
same allocation and provider keys; changes to a reused request are rejected.
Legacy Stripe refunds cannot bypass allocation. Old refunds with unknown tip
allocation require review before any additional refund on that payment.

Stripe refund metadata carries the durable leg key. Recovery reads the provider's
refund history, validates intent/amount, and settles the existing receipt. Lookup
uncertainty never frees the reservation. An unresolved request older than 23 hours
cannot create another refund: readback may recover it, otherwise manual provider
review is required. Verified webhook duplicates also read authoritative outcomes.
Pending provider references are retained; completed effects occur once.

Refunded tips reduce future driver and owner tip entitlement. If a driver was
already paid, an immutable recovery-due row references the refund, driver and
cashout. The timeline and admin order show the due. Original captured amounts,
tips and cashouts remain historical evidence. A due is neither cash received nor
a wage deduction; collection and any payroll treatment require normal authorized
accounting procedures. No automatic collection is implemented.

## Verified production identity (read-only)

Production project: `prj_yuDZ5rpq4jOmRo2KINX6W3KeJM80`; team:
`team_1GeWDK04pXDS0X3jGsLUxN1h`; previous deployment:
`dpl_HoiQny3guq9948WYfLcAtFfhhNDW`; application:
`https://app.hanafymedia.com`; Supabase: `vxpkdmtornkeoedkawkt`.
The staging project is a separate project: `prj_Bg0RzItCkAPgzTaWM71M98RY2PiV`,
Supabase `pkjrdvtdygiprmsojdqg`. Never substitute one for the other.

## Exact production migration scope

Apply only these six additive integration migrations, in order, after separate
production approval and the physical acceptance gate. Use the reviewed release
manifest's SHA-256 hashes, not whichever files happen to be on a workstation:

1. 20261115080000_durable_payment_integration.sql
2. 20261116080000_restore_operational_row_ownership.sql
3. 20261117080000_completed_tip_lease_release.sql
4. 20261118080000_retained_tip_attempt_webhooks.sql
5. 20261119080000_customer_autosave_order_serialization.sql
6. 20261120080000_allocated_stripe_refunds.sql

Do not run an unrestricted `supabase db push`. Staging retains historical durable
migration 20261107080000 and a staging-only owner-tip bridge 20261107080001;
production has a different historical manifest. Neither bridge nor an old branch
history should be replayed into production. Migration 15 installs its coordinator
contained, with execution disabled. Migration 20 preserves current refund/cashout/
closeout bodies and fails closed if their expected integration points differ.

Preflight uses read-only production access: confirm main/deployment identity,
backup/PITR readiness, schema history, columns, function definitions and ACLs.
The review observed zero legacy Stripe refunds, zero pending Stripe refunds, zero
active Stripe authorizations and one captured split payment. Recheck immediately
before cutover; these are snapshots, not assumptions about future state. Preserve
that split's two provider references and any completed cashout. Review any newly
appearing legacy refunds explicitly; never infer their tip allocation silently.

The isolated rehearsal replays all 94 current-main migrations and the actual
read-only production card-tip, customer-writer, refund, driver-cashout and closeout
function definitions. It then applies and reapplies the six integration migrations,
checking partial split state, paused completion, duplicate receipts and containment.
This verifies source/schema compatibility; it is not a full production backup
restore. A restore drill remains a prerequisite if required by restaurant policy.

## Cutover and financial containment

1. Obtain explicit production approval, a maintenance window, database backup/
   PITR checkpoint, and an operator responsible for the manual restaurant fallback.
   Record the exact tested SHA, artifacts, manifest and previous deployment ID.
2. Stop financial entry points before changing schema/code. Use the production
   project's Vercel pause operation (503 for new production traffic), stop external
   job invocations, and restrict any directly reachable preview/immutable hosts
   that share production financial credentials. Confirm new requests cannot reach
   payment routes or Server Actions. A paused public alias alone is insufficient
   if another host or worker still has production financial access.
3. Let in-flight calls finish and inventory pending payments/refunds, Stripe
   intents and provider references. A pause does not kill calls already executing.
   Account for every uncertain outcome before proceeding. Keep signed webhook
   retries queued; provider readback is required after maintenance.
4. Compare actual schema/function hashes to the approved preflight. Apply each
   scoped migration and its schema-history entry in one database transaction;
   stop immediately on drift/failure. No deletion or financial-history rewrite.
   Confirm `pos_tip_capture_control.execution_enabled = false` afterward.
5. Deploy the exact reviewed SHA to the production project while contained. Keep
   the old deployment available for read-only rollback. Verify version, permissions,
   RLS, isolation and disabled capture before restoring any financial traffic.
6. Reconcile retained operations/refunds by their saved provider IDs. Never make
   a new payment to compensate for a missing local receipt. Verify provider gross
   captures, completed refunds, net receipts, tip entitlement and recovery dues
   against database records. Clear all uncertainty or retain containment.
7. Resume traffic/jobs only after operator approval and a verified reconciled
   inventory. Enable the durable tip flag explicitly only when authorized. Monitor
   initial payments/refunds, webhook retries, duplicate attempts and driver cashout.

Vercel project pausing is documented at
https://vercel.com/docs/projects/managing-projects . It can be invoked as
`POST /v1/projects/<verified-production-project-id>/pause?teamId=<verified-team-id>`.
Keep the token in the credential store; never embed it in a runbook or log.
No pause/resume action against production has been performed in this task.

## Rollback / containment decision

If provider and database disagree, stop new financial requests/jobs first, set the
new coordinator flag false if installed, drain in-flight work, and retain all
ledger rows, requests, refund legs, provider IDs, receipts and recovery dues.
New refund requests are not gated by the tip-only flag: network/worker containment
is mandatory. Do not restore an older database snapshot over real financial events.

App rollback alone is unsafe: b73a114 does not honor the durable flag and assumes
one refund intent. Prefer forward repair on the reviewed new app while contained.
If the old app must serve nonfinancial workflows, retain the additive schema and
block every charge/refund/void/tip/cashout mutation and production-backed alternate
host until all pending operations are reconciled and the operator approves the
remaining restrictions. Keep the allocated Stripe-refund guard in place. Never
resume the old single-intent refund action for a split payment.

When an uncertain refund is older than 23 hours, inspect Stripe history by durable
leg metadata and provider ID. Recover an existing result; if no conclusive result
exists, keep it reserved and escalate. Do not generate a different key to force a
retry. A failed leg may be replaced by a new reviewed request only after its
provider failure is definitive; completed legs are never resent.
