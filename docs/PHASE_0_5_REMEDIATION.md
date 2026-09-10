# Phase 0–5 Audit Remediation

## Implemented corrective work

- Database-backed public checkout rate limiting (eight attempts per hashed client address per five-minute window); the endpoint fails closed if it cannot check the limit.
- POS ticket idempotency now keeps one key for a ticket through retries and only makes a new key on explicit clear/new ticket.
- Correct overnight regular-hours evaluation in the database, matching the browser’s prior-day carry-over behavior.
- Correct overnight special-hours carry-over in both the database and public browser settings projection, with unit, migration-integrity, and pgTAP coverage.
- `/order` now provides the required pickup/delivery selection route.
- Customer cart, checkout, and POS ticket show modifiers and item instructions. Customer and POS users can reconfigure an existing line before submission.
- Editing any phone-order identity field clears a selected saved address, preventing an address from another customer being submitted.
- Calendar highlights today; order list cards show source and payment method; order search pages in groups of 50.
- Admin navigation is permission-filtered and the entire admin layout is noindex.
- Google-hosted font dependency was removed; the production build no longer needs a font download.
- Playwright staging-only browser coverage now creates pickup, delivery, walk-in, and phone orders; verifies history/calendar/KDS/print jobs; reloads KDS; and transitions a ticket to ready.

## Owner-controlled work that cannot be safely invented

The audit’s live-menu and configuration findings are production-data decisions. No menu price, tax rate, delivery fee, delivery ZIP list, or store policy was fabricated. Before acceptance, the owner must create and validate at least one real active, customer-visible, POS-visible item with a real variant and modifier group in `/admin/menu`, then configure the operational values in `/admin/settings`.

## Required live acceptance sequence

1. In an isolated staging environment, use the isolated fixture or create a real approved staging item, variant, and modifier group. See `docs/PHASE_0_5_STAGING_ACCEPTANCE.md`.
2. Place pickup and delivery online test/manual orders, then a walk-in and phone order.
3. Confirm each order exists once in order history, its calendar date, KDS, and print queue.
4. Refresh/reconnect the KDS, force a printer failure, inspect it in the print queue, and retry after recovery.
5. Apply the migration to a clean local Supabase stack and run `npm run test:db` when Docker or Podman is available.
6. Run `npm run test:e2e` only against an isolated staging setup with its own fixtures and storage states.

No production cutover or live payment claim is made by this document.
