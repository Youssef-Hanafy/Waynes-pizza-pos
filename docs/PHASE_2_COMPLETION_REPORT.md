# Phase 2 Completion Report — Cart, Customers, and Test Orders

**Implementation:** complete. **Formal acceptance:** pending isolated-staging walkthrough.

## What was built

- `/order` fulfillment selection, a fulfillment-aware menu/cart, editable configured lines, item/order instructions, checkout, and private order-status URLs.
- Phone-normalized customer records, addresses, separate marketing opt-ins, immutable snapshots, cents-only totals, and a clear TEST / MANUAL payment boundary.
- Transactional idempotent checkout, public-write rate limiting, and server-enforced menu/availability validation.

## Files and database changes

- Application modules: `src/app/{order,checkout,menu,api/orders}`, `src/lib/orders`, and `src/lib/content/store-status.ts`.
- `20260908020000_phase2_orders.sql` adds canonical customers, consents, promotions, orders, items, payments, events, and idempotency records.
- `20260909060000_phase0_5_reliability_fixes.sql` adds checkout rate limiting; `20260909070000_phase0_5_special_hours_carryover.sql` fixes overnight special-hour carry-over in server and public-browser paths.

## Environment/setup and verification

No processor secret is used. Before production, the owner/accountant must explicitly configure approved tax, delivery fee/minimum/area, postal codes, hours, and TEST / MANUAL policy. Live payments remain deferred.

Latest repository verification (September 9, 2026): `npm run verify` passed (lint, typecheck, 24 test files / 142 tests, and production build). `npm run test` covers cart arithmetic, modifiers, snapshots, idempotency, rate limiting, and special hours. The pgTAP companions are `003_phase2_orders_rls.test.sql` and `007_phase0_5_special_hours.test.sql`; they await a running local Supabase/Docker stack.

## Exact manual acceptance

1. Place one pickup and one delivery TEST / MANUAL staging order.
2. Double-click submit; confirm one order number exists per attempt.
3. Refresh private confirmations and verify item/modifier/note/address/total snapshots.
4. Edit source menu/customer data in staging; confirm historic snapshots do not change.

## Acceptance checklist

- [x] Pickup/delivery, editing, customer capture, snapshots, rate limiting, idempotency, and confirmation are implemented and tested.
- [x] No raw card data is collected or stored.
- [ ] Owner staging walkthrough is recorded; live processor acceptance is deferred to Phase 11.
