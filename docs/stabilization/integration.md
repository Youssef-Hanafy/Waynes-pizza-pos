# Production-based stabilization candidate

Base: remote main b73a11470726f64820e7966d7c7651fda26e826b, fetched 2026-10-29.

This branch ports only payment coordination and reconciliation into current main.
Android, offline registration, caller ID, printing, order editing, tip drafts,
and driver cash-out remain based on main. No production deployment is authorized.

## Financial protocol

All entry points share a payment advisory lock, a renewable worker lease, an
immutable operation plan, and provider IDs persisted BEFORE confirmation.
Stripe events trigger an authoritative read using the verified connection;
event snapshots never overwrite the ledger. Verified duplicate deliveries retry
reconciliation. Settled outcomes cannot regress and ownership is checked again
under the database lock.

A full replacement decline must be read back and canceled before split fallback.
The separate tip is prepared, bound, confirmed and verified before the original
approval is captured. Each leg has a separate identity and readback receipt.
Only both successful legs can produce the aggregate payment/order receipt.
A timeout or missing database acknowledgment resumes the bound identities; it
cannot authorize a new charge. Both-leg decline leaves the original uncharged.
An explicit zero-tip retry cancels the declined tip first and retains its ID.
Legacy partial split payments and successful replacements are adopted, verified,
and reconciled rather than charged again. Original authorization references,
failed events, timestamps and canceled attempts are retained.

The new coordinator migration has a unique version 20261115080000; it can create
an absent coordinator or upgrade retained staging operations. New installations
start with financial execution DISABLED. Production migration history must be
mapped by semantic identity, not blindly replayed: production uses different
historical version numbers. Staging's old 20261107080000 coordinator conflicts
with main's owner drawer-tip migration; the staging bridge records the latter
as 20261107080001. Never rename or overwrite historical production migrations.

## Keyed-card tips: separate tip by default (owner, 2026-10-29)

After order #36 / W001228 showed "Declined" (the $49.03 order + tip replacement was refused
while the $46.03 approval still held its money), new operations whose tip doesn't fit on the
approval plan `separate_tip` instead of `replacement`: the tip is prepared, bound, confirmed
and verified on its own, then the original approval is captured for the order alone.
Migration 20261121080000 lets the plan enter the existing split path directly
(fallback_to_capture is set atomically with the immutable plan; amount = order + tip,
fallback = order alone). Operations already planned as `replacement` resume unchanged.
The cashier gets a final answer (tip declined / approval can't be charged) instead of
"still being reconciled" when Stripe's answer is definite; retries reuse the bound
identities and never create or confirm another charge.

## Containment and rollback rehearsal

Before any cutover, set the execution stop switch false, stop scheduling new
capture work, inventory pending operations, releases, refunds and provider
receipts, and verify provider/ledger totals. Pausing permits authoritative
readback and reconciliation; it does not authorize new confirmation/capture.
Do not delete operations, remove the additive tables, or roll back financial
records. If a deployed application must be rolled back, keep the upgraded schema
and execution paused until all new multi-intent operations are reconciled.
The legacy application must not resume captures against partial new operations.
Production cutover and rollback require a separately reviewed runbook and approval.

## Physical Elo acceptance (dedicated staging device only)

Install the staging debug APK; confirm the staging hostname and build identity.
Exercise M2 pairing and card read, denied card and retry, authorization with tip,
separate-tip receipt display, printer routing and paper-out recovery, drawer
pulse and shift ownership, caller ID popup/save once, offline order queue and
reconnect without duplicates, app background/restart, Back/Forward navigation,
and driver cash-out. Confirm totals against sandbox and staging after each
payment. Capture screenshots and operator signoff. A disconnected emulator or
unit test cannot certify the physical reader, printer or cash drawer.
