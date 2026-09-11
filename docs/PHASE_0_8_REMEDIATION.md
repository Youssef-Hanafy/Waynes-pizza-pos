# Phase 0–8 Audit Remediation — Completion Report (2026-09-11)

Scope: every finding in the Phase 0–8 audit (`claude/PHASE_0_8_AUDIT.md` in the project), plus six defects found while fixing them. Database changes are in one idempotent migration, `supabase/migrations/20260914080000_phase0_8_audit_remediation.sql`; it is safe on a fresh database and on the hosted project in its current drifted state.

## Findings discovered during remediation (fixed)

| # | Defect | Impact | Fix |
|---|---|---|---|
| D1 | Hosted DB history lists migrations `20260909060000` and `20260909070000` as applied, but their objects were never created (no `order_request_rate_limits`, no `wayne_consume_public_order_rate_limit`, pre-overnight `wayne_store_is_open`). | Hosted online checkout could never succeed (rate-limit call fails → route fails closed with 429). | Migration re-asserts both migrations' objects. |
| D2 | `wayne_consume_public_order_rate_limit(client_key)` — the parameter has the same name as a table column, so every call raised `column reference "client_key" is ambiguous`. | Checkout always 429 even where the function existed. | Rewritten with `#variable_conflict use_column` and an unambiguous local; tested: 8 allowed per 5-minute window, 9th refused. |
| D3 | Supabase default privileges gave `anon`/`authenticated` full INSERT/UPDATE/DELETE/TRUNCATE on 11 tables created after Phase 5; managers could `select signing_secret` from `integration_destinations` through the REST API. | Secret exposure; TRUNCATE is not covered by RLS. | All table grants reset to least privilege; future objects start closed. |
| D4 | `getServerSupabaseEnvironment()` validated `NEXT_PUBLIC_APP_URL` but never passed it, so the service-role client always threw. | The Hanafy worker route (and anything server-privileged) could not run. | Fixed; new `tryGetServerSupabaseEnvironment()`; unit-tested. |
| D5 | Staff permission parsing rejected any permission code the build didn't know. | Adding a permission in the database would sign every staff member out. | Unknown codes are ignored; unit-tested. |
| D6 | Any new Auth user automatically received the cashier role with POS access (customer search/PII). | An accidental public sign-up would get POS access. | New accounts start inactive; the owner grants access in `/admin/staff`. |

## Audit findings

| Audit item | Status | What changed |
|---|---|---|
| **H1** Orders can't be completed/cancelled | Fixed | `wayne_transition_order` (ready→picked up, ready→out for delivery→delivered, complete-now for kitchens that skip KDS steps, cancel with reason). Optimistic concurrency, immutable `order_events`, promo uses released on cancel, `refund_required` flagged if paid. `order.completed` / `order.cancelled` now reach Hanafy. UI: KDS hand-off button, POS **Open orders** panel, admin order-detail actions. New permissions `orders.manage` (owner/manager/cashier/kitchen) and `orders.cancel` (owner/manager). |
| **H2** Not deployed / no staging | Runbook | Needs GitHub, Vercel, and a second Supabase project in your accounts — see [`DEPLOYMENT.md`](DEPLOYMENT.md). |
| **H3** Owner data missing | Surfaced | Dashboard **Before going live** checklist (menu, tax, delivery ZIPs, fee/minimum, phone, staff, Hanafy) with links. Values themselves must come from Ehab/his accountant. |
| **H4** No audit log | Fixed | Immutable `audit_log` (update/delete/truncate blocked) written by triggers on menu, variants, modifiers, settings, special hours, promotions, segments, staff profiles, roles, role permissions, Hanafy settings (secrets redacted), refunds, manual discounts; plus cancellations, event replays, staff account creation and password resets. `/admin/audit` with filters and field-level before/after. |
| **M1** No staff management | Fixed | `/admin/staff`: create accounts (Auth admin API), change role/active/name, reset passwords; cannot change own role, deactivate self, or remove the last owner. |
| **M2** Test-order RPC callable by anon | Fixed | `wayne_create_test_order` and the rate limiter execute only as `service_role`; `/api/orders` uses the service key (returns a friendly 503 if it isn't configured). |
| **M3** Events dropped while Hanafy inactive | Fixed | Events are always queued; the claimer delivers nothing while paused/unconfigured (no attempts or backoff burned) and resumes oldest-first. Integration page shows a paused banner. |
| **M4** No promo admin / per-customer limit | Fixed | `/admin/promotions` (create, edit, schedule in store time, pause, archive); `per_customer_limit` enforced inside both checkout transactions; `promotions.manage` permission. |
| **M5** 36 anon-executable SECURITY DEFINER functions; leaked-password protection off | Fixed / dashboard step | Anonymous callers can execute only the 4 storefront functions plus `wayne_has_permission` (required by the public menu RLS policies; returns false without a session). Staff get only permission-checked RPCs; triggers, helpers, checkout, and outbox workers are internal. Leaked-password protection is a dashboard toggle — see DEPLOYMENT.md step 2.3. |
| **M6** `/admin` is a link grid | Fixed | §14 dashboard: today / yesterday / this week / last week / month-to-date / custom; net, gross, orders, AOV, item sales, discounts, refunds, tax, delivery fees, tips; pickup vs delivery, online vs POS/phone, card/cash/test; sales and orders by hour (with table view); top items; recent orders; new vs returning; operational alerts. Live-refreshes. |
| **L1** pg_net in public | Fixed | Recreated in the `extensions` schema (guarded; falls back with a notice if the platform refuses). |
| **L2** CSV times in UTC | Fixed | Orders CSV has `business_date`, `placed_at_local` (America/New_York) and `placed_at_utc`. |
| **L3** Unbounded kitchen board | Fixed | Board returns active tickets from the last 24 h, max 150; older open orders surface as a dashboard alert. |
| **L4** No error monitoring | Fixed | `src/instrumentation.ts` `onRequestError` → structured log + `app_error_events` (credentials/query strings scrubbed, 90-day retention); visible under Audit → Server errors. |
| **L5** Admin/POS not realtime | Fixed | Dashboard, order list and order detail refresh on kitchen-ticket realtime events with a polling fallback; the POS refreshes its menu every minute without losing the open ticket and polls open orders every 10 s. |
| Timezone-dependent DB test | Fixed | Phase 6 export test compares instants. |

## Verification

- `tsc --noEmit`: 0 errors. `eslint . --max-warnings=0`: 0 problems.
- Unit + PGlite database tests: **186/186 passing**, including 11 new database tests in `tests/phase0-8-audit-remediation.test.ts` (idempotent re-apply, grant lockdown, rate limiter, completion/cancellation, delivery flow, promo limits, paused Hanafy queue, staff rules, audit immutability/redaction, dashboard) and new unit tests for hand-off rules, store-time conversion, dashboard ranges, go-live checklist, promotion form units, staff validation, error scrubbing, and permission parsing.
- Run on the Mac before deploying: `npm run verify` (adds `next build` and the fake-timer print-worker test, which need macOS native binaries) and `npm run test:db` with Docker.

## Owner / developer actions still required

1. Add `SUPABASE_SERVICE_ROLE_KEY` to `.env.local` (and Vercel) — checkout, staff creation and error capture need it.
2. Enable leaked-password protection and disable public sign-ups in Supabase Auth.
3. Deployment runbook (H2).
4. Enter menu, tax rate, delivery ZIPs/fee/minimum, phone (H3) — the dashboard checklist tracks them.
