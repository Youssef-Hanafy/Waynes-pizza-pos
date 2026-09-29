# Hanafy Platform: Phase 14 completion report (Wayne's full regression + production hardening)

**Date:** 2026-09-29
**Builds on:** Phases 10–13
**Migration:** `20261016080000_phase14_regression_hardening.sql` (applied to live Supabase)
**Status:** **Phase 14 passed at the database, type and lint level.** Two checks can only run on the Mac: `npm run verify` (includes `next build`) and `npm run test:e2e` (Playwright). Run both before deploying.

## 1. Regression run (2026-09-29, on a copy of the repo on the Mac's Linux VM)

All 39 database test files run against every migration (1 → Phase 14) in a real Postgres (PGlite):

| Area (build sheet §40 Phase 14) | Covered by | Result |
|---|---|---|
| Online ordering | `phase2-database`, `hanafy-phase4-workspace-configuration`, `hanafy-phase5-service-gating`, `hanafy-phase13-storefront-domains`, `hanafy-phase14-regression-hardening` | pass |
| POS / tickets / drafts | `phase4-database`, `draft-sync-pilot` | pass |
| Phone orders, caller-ID simulator, customer lookup | `phone-workflow`, `phase16-phone-lines-member-offers`, `hanafy-phase10-hardware-devices` | pass |
| Kitchen | `phase5-database`, `phase1-database` | pass |
| Delivery / driver | `hanafy-phase5-service-gating`, `hanafy-phase3-workspace-rls`, `draft-sync-pilot` | pass |
| Payments: manual Boston North terminal, drawer kick, provider path | `hanafy-phase9-payment-connectors`, `print-station`, `hardware.test` | pass |
| Printing | `print-station`, `hanafy-phase10-hardware-devices` | pass |
| Shifts / cash | `hanafy-phase2-operational-backfill`, `hanafy-phase3-workspace-rls`, `database-foundation` | pass |
| Customer metrics / segments | `phase7-database`, `hanafy-phase7-crm-messaging`, `personal-offers` | pass |
| Campaign sending, AWS messaging, consent/suppression | `hanafy-phase7-crm-messaging`, `phase9-outbox-delivery` | pass |
| Automations | `hanafy-phase8-events-automations` | pass |
| Reports | `phase6-database`, `phase3-database` | pass |
| Tenancy, RLS, cross-tenant (Scenarios B–F) | `hanafy-phase1…9` | pass |
| New phases 10–13 | `hanafy-phase10…13` | pass |

**Totals: 39/39 database test files, 266/266 cases passing.** Unit tests: 46 of 49 files pass under the lightweight runner; the other 3 (`rewards/route`, `logging/logger`, `printing/worker`) use `vi.mock` / `vi.spyOn` / fake timers that only the real Vitest provides. They are unchanged by these phases; confirm with `npm test` on the Mac.
`tsc --noEmit` (whole project): **0 errors**. `eslint . --max-warnings=0`: **0 problems**.

One old expectation was updated on purpose: the Phase 6 test expected the dashboard's billing block to be empty; Phase 11 fills it in.

## 2. Hardening applied

1. **Old public menu/deals functions could leak across businesses.** `wayne_public_menu()` / `wayne_public_promotions()` (still used by any deployment older than this commit) returned every business's menu and deals. They now return only Wayne's; the storefront uses the host-scoped functions from Phase 13. Both paths are built by one function per business so they can't drift.
2. Live smoke checks on production data (read-only / rolled back):
   - Menu through the new path is **identical** to the old one: 18 categories, 197 items; deals identical.
   - A failed kitchen print (in a rolled-back transaction) flips the kitchen printer to "Reporting a problem" and back; nothing was left changed.
   - Supabase security advisor: nothing new beyond the expected "RLS on, no policy" for billing tables (they are server-only on purpose) and the platform's intended SECURITY DEFINER RPCs, which each check the caller's role.

## 3. Data preserved (live counts after all migrations)

orders 4 · customers 2 · menu items 341 (197 on the menu) · promotions 1 · phone calls 1 · print jobs 4 · workspaces 1 (Wayne's) · hardware devices 7 (new). No rows were deleted by Phases 10–14.

## 4. Before going live on the new code (you, on the Mac)

```bash
cd ~/Downloads/waynes-pizza-pos
git pull        # if you work from GitHub, otherwise skip
npm run verify  # lint + typecheck + tests + next build
npm run test:e2e
git push origin main   # Vercel deploys main
```

## 5. Known limitations carried forward

- Online ordering / card checkout / Rewards sign-up still run on Wayne's pre-platform order functions, so they stay Wayne's-only; other businesses get info + menu + deals but "ordering not available here yet".
- No bulk import screen (customers/menu) for new businesses yet.
- Billing is manual v1 (no Stripe, no emailed invoices).
- `next build` and Playwright can't run in this session's sandbox (macOS-only native binaries); run them on the Mac.

## Result

Wayne's behaviour is functionally equivalent or better after tenantization, and no data was lost. The Hanafy Platform build sheet (Phases 0–14) is complete.
