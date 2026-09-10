# Phase 3 Completion Report — Admin Orders and Calendar

**Implementation:** complete. **Formal acceptance:** pending isolated-staging reconciliation.

## What was built

- Permission-protected searchable history, permanent order detail/timeline, source/payment badges, filters, and 50-record pagination.
- Store-timezone month calendar, date drill-down, active-sales totals, fulfillment counts, and accessible Today treatment on desktop and mobile.

## Files and database changes

- Application modules: `src/app/admin/{orders,calendar}` and `src/lib/orders/{admin-queries,admin-schemas,admin-format,calendar}`.
- `20260908030000_phase3_admin_orders.sql` adds server-authorized search, detail, calendar projections, and `orders.view` controls.

## Environment/setup and verification

No new variable is required. Owner/manager requires `orders.view`. Latest repository verification (September 9, 2026): `npm run verify` passed (lint, typecheck, 24 test files / 142 tests, and production build). `npm run test` covers calendar utilities, schemas, permission checks, projections, and migration integrity; `supabase/tests/004_phase3_admin_orders.test.sql` is the pgTAP companion and awaits a running local Supabase/Docker stack.

## Exact manual acceptance

1. Create pickup, delivery, walk-in, and phone staging orders.
2. Find each by number, customer name, normalized phone, and date range.
3. Open its calendar date and verify time, source, payment, fulfillment, status, and total.
4. Reconcile calendar count/active sales to history, including a mobile viewport.

## Acceptance checklist

- [x] Search, details/timeline, pagination, calendar, drill-down, timezone behavior, and mobile Today recognition are implemented.
- [ ] Owner reconciliation with staged orders is recorded.
