# Wayne's Pizza POS

Standalone Wayne's Pizza operating-system repository. The product source of truth is [`docs/WAYNES_POS_MASTER_BUILD_SHEET.md`](docs/WAYNES_POS_MASTER_BUILD_SHEET.md).

## Current scope

Phases 0–5 are implemented: a secure foundation; public site and editable menu; idempotent test/manual online ordering; permanent order history and calendar; front-counter/phone POS; and KDS plus a durable print queue abstraction. Live card processing, drivers, reports, CRM automation, physical printers, and production cutover remain intentionally deferred.

Read the phase completion reports in `docs/`, [`docs/PHASE_0_5_REMEDIATION.md`](docs/PHASE_0_5_REMEDIATION.md), and the required [`staging acceptance runbook`](docs/PHASE_0_5_STAGING_ACCEPTANCE.md) before deploying. The app is **not** ready to replace the existing POS until the production checklist is completed.

## Local setup

Requirements: Node.js 22+, npm, and Docker Desktop (for the local Supabase stack and database tests).

1. Install dependencies: `npm install`
2. Start Docker Desktop.
3. Start Supabase: `npm run db:start`
4. Copy `.env.example` to `.env.local`, set `NEXT_PUBLIC_APP_URL`, and insert the anon/service keys printed by Supabase.
5. Reset a clean local database: `npm run db:reset`
6. Set `WAYNES_OWNER_EMAIL` and a temporary 12+ character `WAYNES_OWNER_INITIAL_PASSWORD` in `.env.local`.
7. Bootstrap the owner: `npm run seed:owner`
8. Start the app: `npm run dev`

Remove the initial owner password from the environment after bootstrapping. Never expose `SUPABASE_SERVICE_ROLE_KEY` or owner credentials through a `NEXT_PUBLIC_` variable.

The Phase 1 migration creates the public `wayne-menu` Storage bucket. Menu and website images are validated, resized, autorotated, and converted to WebP before upload.

## Environments

Use separate Supabase projects and secrets for local, staging, and production. The three committed example files document the required variables. Apply migrations to each environment through the Supabase CLI or CI; never point local development at production.

## Verification

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run test:db` (requires a running local Supabase stack)
- `npm run verify` (all checks except the Docker-backed RLS suite)
- `npm run test:e2e` (isolated staging only; install a Playwright browser first with `npx playwright install chromium`)

The browser suite is intentionally skipped unless `E2E_RUN_STAGING=1` and its isolated staging credentials/storage states are supplied. It creates real staging orders and must never target production. Follow [`docs/PHASE_0_5_STAGING_ACCEPTANCE.md`](docs/PHASE_0_5_STAGING_ACCEPTANCE.md) to install the non-production fixture and run it.

## Production readiness gate

Before enabling live ordering, an owner must configure verified tax, delivery fee/minimum/service-area postal codes, menu prices/availability, and operating hours in `/admin/settings` and `/admin/menu`. Keep test/manual ordering disabled in production until the live payment phase is approved. Do not invent operational values or use the default settings for a real service period.

The POS policy is deliberate: scheduled menu availability governs customer online ordering; active, POS-visible, non-sold-out items remain sellable in the front POS so staff can make an explicit operational exception. This is visible policy, not a hidden discrepancy.
