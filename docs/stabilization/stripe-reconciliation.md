# Stripe reconciliation correction

Scope: correct webhook ordering and recover an already charged, durable replacement. This branch remains a staging correction based on `02f3d96`; it is not a replacement for the newer production branch. No production deployment or migration is authorized by this document.

## Failure and correction

A signed `payment_intent.created` snapshot with `requires_payment_method` arrived after authorization. The old webhook wrote that historical status; `wayne_settle_payment` made failure sticky. The $25 replacement subsequently succeeded, but durable completion refused the $20 ledger row because its status was failed.

Both webhook entry points now treat verified events as notifications: the verified connection selects the Stripe credentials and retrieves the current intent. Initial intents waiting for their first card are distinguished from actual declines by the current provider error. Current terminal-reader and replaced-authorization metadata retain the existing special handling. Lookup failures return retryable errors without applying the old snapshot.

The new service-only `wayne_settle_stripe_payment` RPC resolves the payment or operation inside the verified workspace and Stripe provider, takes the existing coordinator advisory lock, and rechecks bindings. It routes captured durable operations through atomic completion. Ordinary settlements use monotonic guards and forward only the selected payment ID to the legacy settlement function, eliminating its OR-selector ambiguity. Square settlement is unchanged. Verified Stripe duplicates retry the same read/reconcile path, including ordinary payments whose first application failed after event registration.

The additive migration replaces only the completion function and adds that scoped webhook entry point. A previously failed row can be repaired only from the frozen operation's exact provider identity/amount, matching payment/order/workspace and an eligible financial disposition. Void/refund conflicts, changed pointers and a possibly captured original are rejected. The transaction preserves failure timestamps/reasons, writes a correction event, commits the existing receipt and tip once, and leaves original release pending. Capture execution can remain disabled throughout this process. No create/confirm/capture is needed to recover an already successful charge. The worker may release the original authorization only after the receipt commits.

## Evidence and validation

The initial PostgreSQL-backed regression run against the old implementation had eight failures in eleven checks, including delayed-created and retained-failed replacement behavior. Further cases cover readback concurrency, provider/workspace ownership, wrong amounts/pointers, terminal dispositions, reference collisions across providers, initial intents and actual declines. Existing concurrency tests keep their behavioral assertions; their webhook fixture now supplies an authoritative read. The ordinary duplicate route assertion was strengthened to require replay rather than preserving the old skip behavior.

`supabase/tests/013_stripe_reconciliation.test.sql` provides 20 hosted pgTAP assertions in a rollback-only transaction. It never enables capture. The five previously failing pgTAP files and browser vertical slice remain independent acceptance gates; this correction does not repair or weaken them.

## Production compatibility review

Production base `b73a11470726f64820e7966d7c7651fda26e826b` contains 17 later commits. Keep its POS history/navigation, offline register, printing, caller-ID/customer handling, Android changes, daily ticket labels, saved tip drafts and route response fields. Do not overwrite these with this branch's older files.

The live/source migration histories differ in both names and applied version ordering. The source timestamp `20261107080000` is occupied by owner drawer-tip behavior on main, while this older branch used it for the durable coordinator. Do not mark the old coordinator migration applied under that conflicting version. A production integration needs a new unique additive migration after inspection of the real schema/history; the correction's explicit prerequisite guard rejects installation without the durable table.

In an isolated PostgreSQL replay of main's full migration source, correction alone is expected to reject the absent coordinator; adding the coordinator followed by the correction verifies additive SQL compatibility. This is not behavioral compatibility or a rehearsal against a production restore.

The material behavioral conflict is main's declined-replacement fallback: it can charge a separate tip and then capture the original authorization, retaining `tip_charge_intent`/`tip_charge_cents`. The old durable coordinator models a single final capture and does not have a frozen, independently persisted split-tip plan. Copying it over main would remove this newer behavior and could double-charge legacy split payments. A narrow integration must preserve that path with durable identities for both legs, refusal/uncertainty rules and explicit adoption/reconciliation of existing separate-tip records, then test it against main. Until that is reviewed and implemented, production integration is BLOCKED. No merge, rebase, cherry-pick or main change was performed.

## Staging procedure

1. Verify the existing staging project/account and keep `execution_enabled=false`. Retain the original failed operation and webhook evidence.
2. Apply only the new additive migration to staging, with a transaction, identity guard and separate history entry. Do not replay historical migrations or their schedulers.
3. Build and deploy the exact reviewed correction commit to the existing separate staging project. This validates the correction only; it is not a production-compatible candidate.
4. Retrieve the original/replacement intents using sandbox credentials; verify the saved replacement has exactly the frozen captured amount. Reconcile its existing receipt through the revised path. Do not create another charge or rewrite/delete operation history.
5. With capture still disabled, let recovery release the original hold after the receipt commits. Verify provider intent count/amounts, ledger/order totals, one tip event and preserved failure evidence.
6. Replay delayed, duplicate and out-of-order signed notifications to both routes. Verify authoritative reads, retry behavior and unchanged financial totals directly. Keep capture disabled for review.

Stripe reference: [event ordering and duplicate delivery](https://docs.stripe.com/webhooks#event-ordering), [PaymentIntent lifecycle](https://docs.stripe.com/payments/paymentintents/lifecycle). Event timestamps alone are not a locking or ordering guarantee.
