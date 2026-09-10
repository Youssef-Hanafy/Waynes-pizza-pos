# Phase 7 Completion Report — Customer Intelligence + Segments

Date: 2026-09-10

## What was built

- Permission-protected customer list and profile pages with customer metrics, addresses, consent history, full order history, active segments, and membership history.
- An authoritative metrics rebuilder derived from qualifying persisted orders and recorded refunds. Cached order count, lifetime spend, AOV, first order, and last order remain reproducible.
- An editable server-authorized segment engine with validated JSON rules for spend, order count, AOV, 30-day order frequency, recency, and SMS/email consent.
- Editable default VIP, High spender, Frequent customer, 30/60/90-day inactive, Text Club, and Email-consented segments, with live population counts.
- Immutable membership history and customer-domain events. Enter/exit events are emitted only when membership actually changes.
- A server-side nightly inactivity evaluator interface plus a manager-triggered operational run button. It deliberately does not create an in-process timer per customer.

## Files changed

- `supabase/migrations/20260910070000_phase7_customer_intelligence.sql`
- `src/lib/customers/schemas.ts`
- `src/lib/customers/queries.ts`
- `src/app/admin/customers/page.tsx`
- `src/app/admin/customers/[id]/page.tsx`
- `src/app/admin/segments/page.tsx`
- `src/app/admin/segments/actions.ts`
- `src/app/admin/layout.tsx`
- `src/app/admin/page.tsx`
- `src/lib/auth/permissions.ts`
- `tests/phase7-database.test.ts`

## Database migration

`20260910070000_phase7_customer_intelligence.sql` adds customer segment, membership-history, and customer-event tables; indexes/RLS; `customers.view` and `segments.manage`; metrics rebuild/evaluation functions; the nightly evaluator interface; and authorized customer/segment query functions.

## Environment and owner setup

No new environment variables are required. Apply the migration to Wayne's Supabase project before deployment. Configure the platform scheduler to invoke `wayne_run_nightly_inactivity_evaluator()` once nightly through an authenticated owner/manager context; the same evaluator is available from `/admin/segments` for a controlled manual run.

## Exact manual verification

1. Sign in as owner/manager and open `/admin/customers`; search by customer name, phone, email, and current segment.
2. Open a profile and confirm its qualifying-order metrics reconcile to its order history, including refunds.
3. Open `/admin/segments`, edit the High spender or VIP threshold, and save. Confirm population and profile membership update.
4. Run the inactivity evaluator. Use customers with two qualifying orders and last-order dates older than 30, 60, and 90 days to confirm the correct memberships.
5. Add a qualifying new order to an inactive customer, rerun the evaluator, and confirm the membership exits once with an event/history row.
6. Sign in as cashier/kitchen staff; confirm customer pages and segment management are denied.

## Automated verification

```text
npm run lint       PASS
npm run typecheck  PASS
npm test           PASS — 26 files, 150 tests
npm run build      PASS
```

Phase 7 tests cover authoritative metric rebuilding, editable VIP/high-spender rules, 30/60/90-day inactivity, idempotent membership enter/exit history, and authorization boundaries.

## Known limitations / deferred items

- Customer merge/deduplication remains deferred as required by the specification.
- Recent Hanafy marketing activity is not shown until the Phase 8/9 integration is built.
- The scheduler is an operational deployment configuration; no unsafe browser timer or per-customer delayed job was introduced.

## Acceptance checklist

| Requirement | Status |
| --- | --- |
| Order changes update reproducible customer metrics | Passes automated coverage. |
| Editable VIP/high-spender/frequent rules work | Implemented through validated server-side rules and population views. |
| 30/60/90-day inactivity works | Passes automated coverage and nightly evaluator interface is implemented. |
| Segment enter/exit events occur exactly on membership changes | Passes idempotence/history coverage. |

The next phase is Phase 8 — Wayne's → Hanafy Event Integration. It has not been started.
