# Closeout bank payouts

Store close out queues the day's Stripe card proceeds and prints the store report. Reprint store report only prints. Saving the drawer closeout also queues through a database trigger in the same transaction. Printer failure does not undo the queued payout. Only managers can queue payouts.

The queue uses the same local order date as the closeout report and includes online and reader cards, including delivery cards awaiting capture and separately charged delivery-tip intents. Cash, other processors and test orders are excluded. Actual USD Stripe balance transactions supply gross amounts, processing fees and refund adjustments. The worker waits for captures, refunds and settlement; it does not estimate fees or pay pending funds using an older balance. Refunds recorded while a batch waits are included. Refunds for earlier orders can be deducted on their refund date; negative batches carry into the next payout. Refunds created after a payout was submitted are handled by a later closeout. An unrecorded external Stripe refund blocks the affected unsent charge until reconciled in the POS.

Each charge/refund can belong to only one batch. Repeated closeouts add only previously unqueued payments; new sales after an earlier payout can create a supplemental batch. A single leased worker prevents simultaneous payouts from racing on the pooled card balance. The exact payout amount and bank destination are saved before contacting Stripe. A timeout triggers history reconciliation with a fixed idempotency key; an unresolved request older than 23 hours stops for review rather than reusing an expired key. Failed/canceled payouts are displayed for review and are not automatically sent again. Paid payouts are rechecked for seven days because bank failures can arrive later.

## Deployment and activation

1. Apply `20261130080000_closeout_bank_payouts.sql` transactionally. Controls default to disabled and no historical closeouts are backfilled. Deploy the matching application before enabling a control.
2. The authenticated read-only `GET /api/payments/payouts/worker?connection_id=...` preflight uses `x-wayne-job-token` from the `closeout_bank_payouts` scheduler secret. It returns merchant identity, key mode, payout eligibility, schedule and linked bank summaries, never credentials. Production requires a matching live connection, enabled payouts, a manual schedule and an existing USD bank account. Stripe test keys cannot list bank accounts; their simulated destination is checked by Stripe on payout creation instead.
3. Bind `closeout_payout_control` to the verified workspace/location, payment connection, Stripe account, existing bank ID and environment, with an explicit start date. Do not change bank details or activate historical dates to reconcile earlier automatic payouts. The five-minute `wayne-closeout-bank-payouts` cron job must be active. Production worker URL is `https://app.hanafymedia.com/api/payments/payouts/worker`; isolated staging uses its staging URL.
4. Enable only after these checks. The application never changes Stripe's payout schedule itself. If Stripe currently pays automatically, change the schedule in Stripe and start after any already scheduled automatic payouts are reconciled.

## Operations

The closeout screen shows waiting, requested, in transit, paid, failed, or review status, the exact net amount once planned, and Stripe's expected arrival date. This is a standard payout to the pinned bank account, not an Instant Payout. `paid` is Stripe's reported status, not a separate bank-statement confirmation.

For a review/failed batch, inspect its Stripe history and recorded `stripe_payout_id` before any intervention. Never delete queue items, clear `submitted_at`, or generate a new payout key to resolve an uncertain outcome. Disable the location control to stop future initiation while retaining its records. If changing processors or closing a location, reconcile every pending payout before disabling the worker permanently. Manual payout mode leaves funds in Stripe when no closeout is queued.

## Verification

Automated tests use isolated PostgreSQL and synthetic Stripe transports to cover disabled controls, date boundaries, manager access, unique membership, supplemental batches, leases, frozen plans, negative refund carry, exact fees, pending settlement, late refunds, bank/mode validation, and lost Stripe/database responses. Live verification reads settings and queue state; it does not charge a customer or initiate a production payout.
