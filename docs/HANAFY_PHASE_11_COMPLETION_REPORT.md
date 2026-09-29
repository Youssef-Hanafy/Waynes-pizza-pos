# Hanafy Platform: Phase 11 completion report (Hanafy billing + equipment balances)

**Date:** 2026-09-29
**Builds on:** Phase 10
**Migration:** `20261013080000_phase11_billing_equipment.sql` (applied to live Supabase)
**Status:** **Phase 11 passed** (database acceptance proven by tests; typecheck + lint clean), subject to `npm run verify` on the Mac.

This is money a business owes **Hanafy Media**. It never touches a restaurant's own customer payments (§38): every table is `platform_*` / `equipment_*`.

## 1. What was built

| Area | What it does |
|---|---|
| Plans (§23.1) | `platform_plans` + `plan_services` (optional standard packages, price may be blank = "per client"). One seeded: **Custom agreement**. |
| Agreements (§23.2) | `workspace_subscriptions`: base agreement or add-ons, price per interval (monthly/quarterly/yearly) in cents, dates, status (trial/active/paused/cancelled), custom terms. One live base agreement per business. Monthly recurring = sum of monthly equivalents. |
| Invoices (§23.3) | `platform_invoices` / `_items` / `_payments`. Numbered `HM-YYYY-0001`. Draft → **issued (unpaid)** → **paid automatically** when payments cover it → or void. Lines lock once issued. Payments can't exceed what's owed, can't be edited, are voided (not deleted); voiding one re-opens the invoice. Credits allowed as "adjustment" lines. |
| Equipment (§23.4) | `equipment_assets` (+ optional link to its `hardware_devices` row), `equipment_charges`, `equipment_payments`. **Balance = charges − payments**, never typed. The agreed price is recorded as the first charge; later charges/credits and payments adjust it. |
| Platform Admin | New **Billing** section (`/platform/billing`: every business's monthly, unpaid, overdue, equipment; overdue invoice list; plans). New workspace tabs **Billing** (agreement, invoices, record payments) and **Equipment**. Dashboard, Businesses list, Overview and Hardware tab now show billing and equipment balances. |
| Business view | `/w/<slug>/billing` "Hanafy bill" for owners/managers (`settings.manage`): agreement, issued invoices, equipment balances. Read-only. |
| Roles | Platform owner/admin/**billing** can change money; support/read-only can view. Every change needs a reason and is audited (platform log + the business's own log). No browser access to any billing table; RPCs only. |

## 2. Acceptance — Platform Admin can answer, for Wayne's

- **What services is Wayne's on?** Billing tab lists the enabled services (Services tab has the detail).
- **What is the monthly price?** Billing tab "Monthly recurring" (from the recorded agreement).
- **What invoices are unpaid?** Billing tab invoices + totals; `/platform/billing` overdue list.
- **Does Wayne's owe money on Hanafy-supplied equipment?** Equipment tab: **$0.00 — Hanafy has not supplied equipment; Wayne's store hardware is owned by the business.**

No agreement or price was invented for Wayne's: the dashboard shows "1 business with no agreement recorded" until you enter the real one.

## 3. Tests

| Check | Result |
|---|---|
| `tests/hanafy-phase11-billing-equipment.test.ts` (6) | **pass** |
| `src/lib/platform/money.test.ts`, `schemas.test.ts` | **pass** |
| `tsc --noEmit` | **0 errors** |
| `eslint` changed paths | **0 problems** |

## 4. Manual steps (you)

1. `/platform/workspaces/waynes-pizza/billing` → **Record the agreement** with the real monthly price for Wayne's.
2. Create the first invoice (tick "Add this period's agreement lines"), **Issue**, then **Record payment** when paid.

## 5. Known limitations

Manual v1 by design (§23.5): no Stripe, no automatic monthly invoice runs, no emailed PDFs. Equipment installments are tracked on the equipment ledger, not as invoice lines.

## Next

Phase 12: Add Business provisioning flow.
