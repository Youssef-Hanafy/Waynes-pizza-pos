# Phase 4 Completion Report — Front POS

**Implementation:** complete. **Formal acceptance:** pending isolated-staging staff walkthrough.

## What was built

- Touch-oriented permission-protected `/pos` for anonymous walk-ins and identified phone pickup/delivery orders.
- Customer lookup/create, saved addresses, stale-address clearing after identity edits, modifiers, reconfigurable lines, notes, TEST / MANUAL or unpaid-cash designation, and audited manager discounts.
- One ticket idempotency key retained through retries and rotated only after explicit new/clear ticket.

## Files and database changes

- Application/API modules: `src/app/pos`, `src/app/api/pos`, and `src/lib/pos`.
- `20260908040000_phase4_front_pos.sql` adds POS/discount permissions, secure POS menu/customer projections, and the canonical POS/phone transaction.

## Environment/setup and verification

No payment-provider credential is used. Cash designation is unpaid cash due, not a completed payment. Latest repository verification (September 9, 2026): `npm run verify` passed (lint, typecheck, 24 test files / 142 tests, and production build). `npm run test` covers permissions, canonical persistence, customer metrics, discounts, idempotency, snapshots, and stale-address prevention; `supabase/tests/005_phase4_front_pos.test.sql` is the pgTAP companion and awaits a running local Supabase/Docker stack.

## Exact manual acceptance

1. As cashier in staging, submit a walk-in pickup with a modifier and note.
2. Start a new ticket, enter a phone delivery with address, and submit.
3. Retry an interrupted submission before clearing; confirm one order exists.
4. Verify both records in history, calendar, KDS, and the identified customer’s metrics.

## Acceptance checklist

- [x] Walk-in/phone POS, reconfiguration, staff permissions, customer safety, and retry behavior are implemented and tested.
- [x] Scheduled menu availability is intentionally online-only; active, POS-visible, non-sold-out items remain staff-sellable.
- [ ] Staging cashier/manager walkthrough is recorded; live card-present and drawer closeout are deferred.
