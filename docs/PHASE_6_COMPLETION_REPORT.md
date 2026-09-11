# Phase 6 Completion Report — Dashboard + Core Reports

Date: 2026-09-10

## What was built

- Permission-protected `/admin/reports` with New York business-date filters, dashboard cards, sales/order trend charts, reconciliation figures, source/fulfillment/payment splits, daily sales, item sales, and CSV exports for orders, daily summaries, and items.
- Authoritative reporting RPCs. They calculate from immutable order totals, order status, persisted refund ledger rows, and historical item/category snapshots—never from client state.
- Durable `payments` and `refunds` ledger interfaces for the later processor/refund workflow, plus an order-item category snapshot trigger so later menu edits cannot rewrite historical reports.

## Files changed

- `supabase/migrations/20260910060000_phase6_reports.sql`
- `src/lib/reports/schemas.ts`
- `src/lib/reports/queries.ts`
- `src/app/admin/reports/page.tsx`
- `src/app/api/reports/export/route.ts`
- `src/lib/auth/permissions.ts`
- `src/app/admin/layout.tsx`
- `src/app/admin/page.tsx`
- `tests/phase6-database.test.ts`

## Database migration

`20260910060000_phase6_reports.sql` creates `payments` and `refunds`, adds the immutable `order_items.category_name_snapshot`, `reports.view` authorization, supporting indexes/RLS, and three server-authorized report functions.

## Environment and owner setup

No environment variables are added. Apply the migration to the Wayne's Supabase project before using reports in a deployed environment.

## Manual verification

1. Sign in as an owner or manager and open `/admin/reports`.
2. Run a range that includes orders on either side of midnight UTC; verify assignment follows the configured `America/New_York` date.
3. Compare order CSV totals with `/admin/orders` for the same range, excluding cancelled orders.
4. Record a future authorized refund through the Phase 11 payment/refund workflow and confirm it appears as a deduction on the business date it was issued.
5. Sign in as cashier/kitchen staff and verify Reports is hidden and `/admin/reports` is denied.

## Known limitations / deferred work

- Live payment capture and the operator refund action intentionally remain Phase 11 work. The ledger and reporting treatment are in place now; no fake payment/refund UI was added.
- Daily sales and daily order charts are provided, with the detailed date/value table retained as the accessible representation.

## Acceptance checklist

| Requirement | Status |
| --- | --- |
| Dashboard cards, sales/orders trends, source/fulfillment splits, item reporting, date filters | Implemented. |
| CSV exports for initial data sets | Implemented for orders, daily summaries, and item reporting. |
| Totals reconcile to authoritative orders | Implemented through server-authorized SQL and automated coverage. |
| Refunds/discounts affect net reporting | Implemented and tested. |
| New York business-day boundaries | Implemented and tested. |

Phase 7 — Customer Intelligence + Segments is implemented. See `PHASE_7_COMPLETION_REPORT.md` and `PHASE_6_7_AUDIT_REMEDIATION.md` for its operational status.
