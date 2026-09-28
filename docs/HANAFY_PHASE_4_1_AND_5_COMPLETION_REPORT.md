# Hanafy Platform: Phase 4.1 fixes and Phase 5 completion report

**Date:** 2026-09-28
**Builds on:** Codex Phases 1–4 (`d2d8188`, `1d743f3`) and the Phase 0 audit (`docs/HANAFY_PLATFORM_PHASE_0_AUDIT.md`)
**Live database:** Supabase `vxpkdmtornkeoedkawkt`. Both migrations are applied and recorded under their file versions (`20261006080000`, `20261007080000`).
**Status:** **Phase 4 fixes: passed. Phase 5: passed**, subject to the Mac build check below.

---

## 1. What was built

### Phase 4.1: audit fixes that finish Phase 4

| Fix | Result |
|---|---|
| Live storefront showed "Store unavailable" | `waynes-pizza-pos.vercel.app` and `www.waynespizzaofworcester.com` are registered to Wayne's / Worcester. Verified live: /contact shows Wayne's name, address and phone. Unknown hosts still resolve to nothing. |
| SMS sender was the store landline | Wayne's SMS identity is now `+15136764597` (AWS End User Messaging, us-east-1, origination `phone-ae22…`). The unprovisioned email identity is switched off. |
| Services didn't match reality | `sms` and `automations` are enabled for Wayne's. `email` stays off until an email provider exists. |
| Missing statuses | Workspaces and locations gain `provisioning`. Services gain `suspended`, plus `source` (plan/manual/custom_contract) and a `starts_at`/`ends_at` window that entitlement honours. Adds the `platform_billing` role. |
| Platform owner | New `platform_user_invites` table. `hanafymedia@gmail.com` is invited as `platform_owner` and redeemed automatically when that account exists **with a confirmed email**. Being a workspace owner never makes someone a platform admin. |
| Two sources of truth for settings | Phase 4 moved admin saves to the new tables, but 16 legacy functions still read the old ones. Mirror triggers now keep `location_settings`↔`store_settings`, `location_hardware_configurations`↔`pos_hardware_settings`, `location_payment_configurations`↔`payment_provider_settings` and `location_caller_lines`↔`store_phone_lines` identical in both directions. They are guarded against re-entry, and the table CHECK rules still validate every save. |
| Phase 4 defects | Saving settings no longer overwrites the SEO About title with the description. Hostname normalisation is fixed. |
| Remaining hard-coded Wayne's text | New settings `brand_name`, `brand_short_name` and `rewards_program_name` are editable in Admin → Website and seeded for Wayne's with today's exact wording. They now drive: the Rewards name everywhere, the SMS consent text (Wayne's wording is byte-identical, same consent version), checkout opt-in labels, "please call …" errors, card-payment notes, legal pages, badge label, POS, kitchen and driver headers, admin header, login page, printer and hardware messages, and the default city/state on new addresses. |

### Phase 5: workspace shell and service gating

- **Enforcement lives in the database.** A new `service_permissions` map states which service owns each permission. `hanafy_has_workspace_permission` and `wayne_has_permission` (both forms) only grant a permission while one of its services is active. One change therefore covers **navigation, pages, server actions, API routes, the 152 legacy `wayne_*` RPCs and RLS**. Core permissions (`admin.access`, `settings.manage`, `audit.view`) are never gated.
- **Write guards.** Online orders need `online_ordering`, POS and phone orders need `pos`, caller-ID rings need `caller_id`, and delivery assignments need `delivery`. These checks apply to every write path, the service-role key included.
- **CRM hand-off.** Hanafy CRM delivery (the outbox) waits while `crm` is off. Events stay queued and send in order when it is turned back on; nothing is dropped.
- **Workspace selection.** `hanafy_current_workspace_access(slug)` validates the chosen workspace against the user's memberships. Someone in two businesses gets nothing until they choose one; there is no guessing. The choice is remembered as a slug-only httpOnly cookie that is re-validated on every request.
- **Workspace shell** `/w/[workspaceSlug]`:
  - **Header:** the business name is always shown, a "Viewing as Hanafy platform staff" banner appears for non-members, and a business switcher does full-page navigation so no data carries over.
  - **Navigation:** module-aware, built from effective permissions and enabled services.
  - **Overview page:** today's orders and sales, read through RLS with a workspace filter, plus service on/off status and locations.
  - **`/w`:** a picker for users with several businesses; users with one go straight in.
- **Existing screens keep working.** `/admin`, `/pos`, `/kitchen` and `/driver` stay where they are, so tablets and the Android app need no change. They now show the workspace name and hide modules that are off. A blocked page redirects to the workspace overview with "X is not enabled for Wayne's Pizza".
- **Legacy-code guard.** The operational screens still run on Wayne-only functions. For any other business they withhold operational permissions and send the user to the workspace shell, so no other business can ever act through Wayne's code path.
- **Storefront gating by host:**
  - An unknown host or a missing `website_storefront` service returns 404.
  - Menu, checkout and order need `online_ordering`.
  - Rewards and personal offer links need `sms`.
  - The Rewards buttons and the checkout text opt-in hide when SMS is off.
  - Public order, card and Rewards APIs return 403 `SERVICE_DISABLED` and never fall back to another business.
- **Settings screens use the signed-in workspace, not the host.** Admin and POS settings, and payment-provider lookup for POS terminal charges and refunds, now come from the signed-in workspace rather than the web address.
- **Client state (§37).** Saved POS drafts are keyed `hanafy:{workspaceId}:pos-drafts.v1`; Wayne's existing drafts move over once. Realtime subscriptions for kitchen tickets, print jobs, drafts and phone calls are filtered to the workspace.
- **Phone.** The Phone tab and button hide when `caller_id` is off, and the phone APIs return 403.

## 2. Existing behaviour preserved

- Wayne's has every service it used before (plus sms and automations), so the owner's effective permissions are identical: verified live, 26 of 26.
- **Deployed-app compatibility.** The old zero-argument `hanafy_current_workspace_access()` and one-argument save functions still exist, so the app on Vercel keeps working until the new code deploys.
- The consent wording and version are unchanged for Wayne's, as are the Android bridge names (`WaynesNativeHardware`) and the outbox behaviour.
- The storefront hero marketing copy is unchanged apart from names; see §8.

## 3. Files

**New:**
- Migrations: `supabase/migrations/20261006080000_phase4_1_platform_fixes.sql`, `20261007080000_phase5_workspace_shell_service_gating.sql`
- Workspace shell: `src/app/w/page.tsx`, `src/app/w/[workspaceSlug]/{layout,page}.tsx`
- Tenancy library: `src/lib/tenancy/{services,navigation,active-workspace,client-scope,public-service}.ts`
- Components: `src/components/ops/workspace-scope.tsx`, `src/components/site/storefront-brand.tsx`
- Tests: `tests/hanafy-phase4-1-platform-fixes.test.ts`, `tests/hanafy-phase5-service-gating.test.ts`, `src/lib/tenancy/{services,navigation,active-workspace}.test.ts`, `src/lib/wayne/rewards.test.ts`

**Changed:**
- Auth and routing: `src/lib/auth/{access,permissions,routes}.ts`, `src/proxy.ts`
- Settings and payments: `src/lib/content/{queries,schemas}.ts`, `src/lib/payments/config.ts`
- Tenancy: `src/lib/tenancy/{context,schemas}.ts`
- Orders, rewards and client stores: `src/lib/orders/drafts.ts`, `src/lib/wayne/rewards.ts`, `src/stores/*`
- Caller ID: `src/hardware/caller-id/cloud-provider.ts`
- Admin: layout, overview, settings, hardware, payments, orders, promotions and reports pages and actions
- POS, kitchen, driver and storefront pages
- API routes: orders, card payments, Rewards, Rewards offers, phone, POS terminal
- Site components

## 4. Database changes

- **New tables:** `platform_user_invites`, `service_permissions` (32 rows).
- **New columns:** `workspace_services.source`, `starts_at`, `ends_at`.
- **New functions:** `hanafy_service_active`, `hanafy_permission_entitled`, `hanafy_entitled_permissions`, `hanafy_active_services`, `hanafy_legacy_workspace_id`, `hanafy_my_workspaces`, `hanafy_public_workspace`, `hanafy_workspace_store_settings`, `hanafy_location_store_settings`, `hanafy_selected_location`, `hanafy_normalize_hostname`, and the mirror and guard triggers.
- **Changed functions:** the permission predicates, `hanafy_workspace_context`, `hanafy_current_workspace_access` (plus a new text overload), the save functions (new slug overloads), `wayne_claim_hanafy_outbox`, and `hanafy_sync_legacy_waynes_membership` (a new Auth user is no longer added to Wayne's until a Wayne's manager activates them).
- **RLS:** no policy text changed. Every existing policy now also enforces entitlement through the shared predicate. New tables have RLS; `platform_user_invites` is readable by platform admins only.

## 5. Tests

These run on the linked Mac's Linux shell: node_modules there are macOS builds and the npm registry is blocked in this session, so Vitest's native bundler cannot load and I used a small Vitest-compatible runner instead.

| Check | Result |
|---|---|
| `tsc --noEmit` | pass |
| `eslint . --max-warnings=0` | pass |
| DB tests (all migrations in PGlite), 30 files | **all pass**, including the 2 new files (8 + 9 cases) |
| Unit tests (`src/**`) | pass, except 2 that need real Vitest features (`vi.mock` in `api/rewards/route.test.ts`, fake timers in `printing/worker.test.ts`). They were **not run** here, and the rewards route test was extended for the new behaviour. |
| `next build`, `test:db`, `test:e2e` | **not run** (they need the Mac): run `npm run verify` there |

The Phase 5 DB tests prove:
- A disabled service withdraws permissions and RLS visibility; re-enabling restores them.
- The legacy RPC check is gated in the same way.
- Explicit selection works with several memberships, and a foreign slug gets nothing.
- Config saves only land in the selected workspace.
- Host → services lookup works, and unknown hosts get nothing.
- Order, ring and delivery write guards work.
- Outbox hold and release work.
- New Auth users are not auto-enrolled.

The tests caught one real bug before it went live: the write guard would have failed every phone-call insert.

## 6. Manual steps for you

1. On the Mac, run `npm run verify` (lint, typecheck, tests, build), then `git push origin main`. Pushing can't be done from this session.
2. **Platform-owner login.** In Supabase (project Waynes Pizza POS) → Authentication → Add user: create `hanafymedia@gmail.com` with a password and tick *Auto confirm*. It becomes `platform_owner` automatically, and it is **not** added to Wayne's staff.
3. After Vercel deploys, check:
   - `/w` redirects to `/w/waynes-pizza`, and the overview shows today's figures.
   - `/admin` shows "Wayne's Pizza" and every section as before.
   - A test online order and a simulator call still work.
4. **Optional gating test.** In SQL, set `status='disabled', disabled_at=now()` on Wayne's `delivery` row in `workspace_services`. Delivery and Driver disappear, `/driver` redirects with "Delivery is not enabled", and `/api/driver` returns 403. Set it back with `status='enabled', disabled_at=null`.

## 7. Acceptance checklist

| Requirement | Result |
|---|---|
| Phase 4 audit blockers fixed (storefront host, SMS sender, services) | ✅ (live) |
| Phase 4: changing workspace config changes behaviour without code (names, consent, errors, city/state, receipts) while Wayne's looks the same | ✅ |
| Phase 5: workspace navigation | ✅ |
| Phase 5: workspace switcher | ✅ |
| Phase 5: module-aware navigation | ✅ |
| Phase 5: server-side entitlement enforcement (pages, actions, APIs, RPCs, RLS, writes) | ✅ |
| Phase 5: workspace overview | ✅ |
| Disabling a service removes UI and blocks server actions; enabling restores | ✅ (DB tests; UI via manual step 4) |
| No cross-tenant fallback (unknown host, foreign slug, legacy code path) | ✅ |
| Production build verified | ⏳ Mac `npm run verify` |

## 8. Known limitations / deferred

- **SMS is enforced on this side only.** The CRM is a separate Supabase project and still decides SMS sends itself; Phase 5 enforces SMS on the POS side only. Making the CRM respect workspace services is Phase 7 (tenantize CRM and messaging).
- **Legacy functions remain Wayne-only.** The Wayne-default scope triggers, the global unique constraints and the single-column FKs from the audit remain, so **don't add a second real business yet**. This needs a dedicated "scope legacy RPCs" phase before Phase 12.
- **Storefront marketing copy** (hero "Over 50 years…", homepage sections, menu photo placeholder) is still Wayne's content. It moves to tenant storefront configuration in Phase 13.
- **Card webhooks** still resolve the business by host (now registered). Per-connection webhook URLs come in Phase 9.
- **Platform audit and support mode** (audited "enter workspace as Hanafy") are Phase 6. For now the shell only shows a banner for non-members.
- The CRM source code is on branch `main` of `~/Downloads/hanafy-retention-v1` (its checked-out branch is an old Wayne's copy). It needed no change in this phase.
