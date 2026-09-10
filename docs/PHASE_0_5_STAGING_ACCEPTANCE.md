# Phase 0–5 Staging Acceptance Runbook

This is the required evidence path for the first vertical-slice milestone. It is for an isolated staging Supabase project only. Do not run it against production and do not use its fixture values as business operating data.

## One-time staging preparation

1. Apply every committed migration, including `20260909070000_phase0_5_special_hours_carryover.sql`.
2. Create owner and cashier test accounts, with `admin.access`/`kitchen.access`/`printing.manage` for the owner and `pos.access` for the cashier.
3. Run `supabase/fixtures/phase0-5-staging-vertical-slice.sql` in the staging SQL editor or a staging-only database pipeline. It creates the explicitly labelled `Staging Supreme Pizza` fixture and 24-hour TEST / MANUAL staging settings.
4. Create Playwright storage-state files for the staging owner and cashier. These files contain authenticated sessions and must stay outside Git.
5. Set `E2E_BASE_URL`, `E2E_RUN_STAGING=1`, `E2E_MENU_ITEM=Staging Supreme Pizza`, `E2E_OWNER_STORAGE_STATE`, and `E2E_POS_STORAGE_STATE` in the staging test environment.
6. Run `npm run test:e2e`. A missing staging setting fails the test; the default local invocation skips it deliberately.

## Required human verification

The automated journey creates online pickup and delivery, POS walk-in and phone-delivery orders; double-clicks checkout; verifies the server-authoritative order-history total is exactly one for the unique checkout phone; verifies history/calendar/KDS/print jobs; reloads KDS; and transitions a ticket through ready. A manager must additionally:

1. Confirm the date summary count and active sales equal the four created orders.
2. Open each order detail and verify snapshots, source, payment designation, modifier, and notes.
3. Take the kitchen tablet offline, reconnect it, and confirm current tickets are restored.
4. With a real staging print agent and printer, force a definite print failure. Confirm the job remains visible as failed, inspect the printer, record a retry reason, retry once, and confirm the order remains intact.
5. Record the test date, operator, order numbers, printer/agent model, and pass/fail evidence in the release record.

## Production gate

No production menu, tax rate, delivery fee, postal-area restriction, payment setting, printer configuration, or business-hour override is supplied by this fixture. Those values require owner/accountant approval in `/admin/settings` and `/admin/menu`. TEST / MANUAL ordering and physical printing must not be presented as live payment/receipt processing.
