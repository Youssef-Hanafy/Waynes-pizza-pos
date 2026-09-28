# Hanafy Platform: Phase 6 completion report (Platform Admin foundation)

**Date:** 2026-09-28
**Builds on:** Phase 4.1 + 5 (`f5cedf4`)
**Live database:** Supabase `vxpkdmtornkeoedkawkt`. Migration `20261008080000_phase6_platform_admin_foundation` is applied and recorded under its file version. The live function definitions were checked against the repository file (identical fingerprints).
**Status:** **Phase 6 passed**, subject to the Mac build check (§6).

---

## 1. What was built

### Platform Admin at `/platform` (§11)

`/platform` is Hanafy's internal console. It is separate from `/admin`, which is a business's own back office. Only active `platform_users` can open it. Everyone else gets a plain 404, business owners included, so the console never advertises itself.

| Screen | What it shows |
|---|---|
| **Dashboard** `/platform` | Businesses by status (active, provisioning, suspended), total customers (a platform-wide count, no customer rows), orders in the last 24 h, staff and platform-user counts, a "Needs attention" list built from health checks, a businesses table, live support sessions (with revoke), and recent platform activity. The billing and equipment card reads "Phase 11". |
| **Businesses** `/platform/workspaces` | The §11.2 columns: business, status, primary location, services on, owner, messaging number, payment provider, hardware, Hanafy billing (Phase 11), health and created date. Filter by status; search by name, owner email or city. |
| **Business detail** `/platform/workspaces/[slug]` | Tabs for Overview, Services, Users, Health and Audit, plus the support-session entry panel. |
| **Overview** | Owner, staff count, customer and order counts, web addresses, services, messaging identities, payment connection **metadata only**, registers and caller lines, locations, and support-session history (which the business also sees). |
| **Services** | Every catalogue service with its status, source (plan, manual or custom contract), start and end dates, whether it is active now, what it needs and what needs it, and the permissions it controls. Owners and admins can change a service; a reason is required. |
| **Users** | Staff accounts with role, status and last sign-in. Owners and admins can add someone: an existing sign-in by email, or a new sign-in with a name and temporary password. They can also change a role or suspend an account. A reason is required. |
| **Health** | CRM outbox (waiting, failed, oldest, last delivered, last error), last order and 24 h order count, payment webhook problems, print failures and stuck jobs, last real caller-ID ring, registers. |
| **Audit** | Hanafy's own actions on this business, and the business's audit log (summaries only; field-level changes stay in the business's back office because they can contain customer data). |
| **Audit log** `/platform/audit` | Every Platform Admin action: who, when, why, before and after. |

### Platform roles

| Role | Console | Change services and users | Enter a business (support) |
|---|---|---|---|
| platform_owner, platform_admin | ✅ | ✅ | ✅ full permissions for that business |
| platform_support | ✅ | — | ✅ **read-only** (orders, reports, customers, staff, audit) |
| platform_billing | ✅ (no business audit logs) | — | — |
| platform_read_only | ✅ | — | — |

### No more invisible access (§8.4)

Before Phase 6, an active `platform_owner` or `platform_admin` silently held every permission in every business: RLS, the `wayne_*` RPCs and the shell all let them through. **That bypass is gone.**

- Hanafy staff act inside a business only during a **support session**. Each session is for one business, has a written reason and an optional ticket number, and lasts 15 minutes to 8 hours (default 1 hour). Each person can have one open session at a time.
- While a session is live, `/admin`, `/pos`, `/kitchen`, `/driver` and `/w/[slug]` work for that business, with a banner saying "Viewing Wayne's Pizza as Hanafy Platform support… End support session". The full-screen POS, kitchen and driver screens show a small pill instead. The display name reads "Name (Hanafy support)".
- **Every audit row written during the session is stamped** with `actor_type = platform_user`, the session id, and "(Hanafy support)" on the name. That holds whether the row comes from menu edits, settings, refunds or anything else, because a trigger on `audit_log` does the stamping.
- **The business can see the sessions.** Anyone with `audit.view` can read the `platform_support_sessions` rows for their own business.
- Ending the session, letting it expire, or deactivating the platform user removes access immediately.
- Private storage follows the same rule: support sessions only, and only owners and admins can write.
- Without a session, a platform user who opens `/w/waynes-pizza` sees a note with no modules, and `/admin` sends them to `/platform`.

### Service changes (§9.3, §11.3, §39)

- **Requirements** are stored in the new `service_requirements` table:
  - SMS, email and automations need CRM.
  - Caller ID needs POS.
  - Delivery needs POS or online ordering.
- A service cannot be turned on before what it needs, or turned off while something that needs it is still on.
- **Business-critical switches ask twice.** Turning off or suspending POS, online ordering, the website, delivery, CRM or SMS first shows what will happen. For example: "The register, kitchen screen and phone orders stop working immediately", "3 register/phone orders are still open". The change goes through only after an explicit "Yes, make this change".
- Start and end dates are whole days on the business's clock. A window that has ended switches the service off without anyone touching it (Phase 5 entitlement already honours it).

### Audit (§29)

- New append-only **`platform_audit_log`**. It has before and after data, a reason, a correlation id and the support session. Updates, deletes and truncate are blocked.
- `audit_log` gains `actor_type` (`workspace_user`, `platform_user` or `system`), `reason`, `correlation_id` and `support_session_id`. Rows from before Phase 6 keep `actor_type` null, because the log is immutable.
- Every console change also lands in the **business's own audit log**, as "Name (Hanafy)", with the reason.

## 2. Existing behaviour preserved

- Wayne's owner (live check): 26 of 26 permissions, role `owner`, no platform access, and `hanafy_platform_*` refused. Their audit rows are stamped `workspace_user`.
- No platform user existed on the live DB, so no one's access changed on deploy.
- The old zero-argument access function and the Phase 5 function signatures are unchanged, so the currently deployed Vercel build keeps working before the new code ships.
- Wayne's staff still live on `profiles`. Platform user changes for Wayne's update the profile, and the membership mirror keeps working. Adding someone to another business never enrols them in Wayne's (tested).

## 3. Files

**New**
- `supabase/migrations/20261008080000_phase6_platform_admin_foundation.sql`
- `src/app/platform/{layout,page,actions}.tsx|ts`, `src/app/platform/audit/page.tsx`
- `src/app/platform/workspaces/page.tsx`, `src/app/platform/workspaces/[workspaceSlug]/{layout,page}.tsx`, `…/{services,users,health,audit}/page.tsx`
- `src/lib/platform/{schemas,queries}.ts`, `src/lib/platform/schemas.test.ts`
- `src/components/platform/{platform-tabs,format}.tsx`, `src/components/ops/support-banner.tsx`
- `tests/hanafy-phase6-platform-admin.test.ts`

**Changed**
- `src/lib/auth/{access,permissions,routes}.ts` and their tests: `hanafy_support` access role, `support_session`, `/platform` protected, and platform users with no business sent to `/platform`.
- `src/lib/tenancy/{permissions,schemas}.ts` and test: removed the app-side platform-admin permission bypass.
- `src/proxy.ts`: `/platform` added to the matcher.
- `src/app/admin/layout.tsx`, `src/app/w/page.tsx`, `src/app/w/[workspaceSlug]/layout.tsx`, `src/app/{pos,kitchen,driver}/page.tsx`: support banners and pill, and the Platform Admin card in the business picker.

## 4. Database

- **New tables:** `platform_support_sessions`, `platform_audit_log`, `service_requirements` (5 rows). All have RLS enabled, read-only access for signed-in users, and no write policies. Writes go through the RPCs only.
- **New columns:** `audit_log.actor_type`, `reason`, `correlation_id`, `support_session_id`.
- **New functions:**
  - Role and session helpers: `hanafy_platform_role`, `hanafy_require_platform_role`, `hanafy_support_session_role` / `_id` / `_permissions` / `_permission_allowed`, `hanafy_my_support_session`.
  - Console reads: `hanafy_platform_me`, `hanafy_platform_dashboard`, `hanafy_platform_workspaces`, `hanafy_platform_workspace_summary` / `_health` / `_detail` / `_members` / `_audit`, `hanafy_platform_audit`.
  - Console writes: `hanafy_platform_set_service`, `hanafy_platform_set_member`, `hanafy_platform_start_support`, `hanafy_platform_end_support`.
  - Audit: `hanafy_platform_write_audit` (internal), and the `hanafy_stamp_audit_actor` trigger.
- **Changed:** `hanafy_has_workspace_permission`, `wayne_has_permission(uuid, text)`, `hanafy_can_access_workspace_data`, `hanafy_workspace_context` and `hanafy_current_workspace_access(text)` now grant access through membership or a live support session. The platform bypass is removed.
- **RLS:** the 4 private-storage policies now require a support session instead of platform admin. No other policy text changed; everything else gets the new rule through the shared predicate.
- **Advisors:** the only new notices are the expected "authenticated can call SECURITY DEFINER" warnings for the console RPCs. Each one checks the caller's platform role itself and none is callable by `anon` (tested). There were no new RLS gaps.

## 5. Tests

| Check | Result |
|---|---|
| New DB tests `tests/hanafy-phase6-platform-admin.test.ts`, 8 cases, all migrations applied on real PostgreSQL 16 | **pass** |
| Phase 1, 3, 4.1 and 5 Hanafy DB tests plus `database-foundation`, re-run with Phase 6 applied | **pass** (no regressions) |
| Migration-integrity tests | pass |
| Unit tests: routes, access, tenancy permissions, services, active-workspace, new `platform/schemas.test.ts` | pass |
| Typecheck of every new and changed file (strict, `noUnusedLocals`) | no errors |
| Live probes in rolled-back transactions: owner access unchanged; owner refused by the console; a probe platform admin had no access before its session, full access during it (4 orders visible), and none after it ended; confirmation prompt; requirement guard ("Turn off Caller ID first: it needs Point of sale") | **pass** |
| `next build`, `eslint`, full `vitest`, Playwright | **not run.** This cloud session has no npm registry access. Run `npm run verify` on the Mac. |

The Phase 6 DB tests prove:
- A business owner cannot use any console function or see the platform log.
- A platform owner without a session has no access inside a business.
- Staff at every platform role see the dashboard, list and detail, and read-only staff can't change anything.
- Service requirements and the business-critical confirmations work, including for online ordering, POS and SMS.
- Scheduled end dates switch a service off.
- Every change reaches both logs with its reason.
- User management works, and the last owner can't be removed.
- Wayne's profile mirroring works, and joining another business never enrols the account in Wayne's.
- Support sessions give access to one business only, are stamped in the audit log, are visible to the business, and end on command, on expiry or when the platform user is deactivated.
- `platform_support` sessions are read-only.
- The platform log is append-only, and no console function is executable by `anon`.

The live probe found one real bug before release: three confirmation messages failed with "could not determine polymorphic type". It is fixed in the migration file and live, and there is now a test for it.

## 6. Manual steps for you

1. **Bring the code to the Mac.** This session built and committed Phase 6 in the cloud copy of the repo. Apply the commit (or the patch in `docs/HANAFY_PHASE_6.patch` if it was delivered that way). Then run `npm run verify` and `git push origin main`.
2. **Create your platform-owner login** (from Phase 4.1, if not done). In Supabase → Authentication → Add user, create `hanafymedia@gmail.com` with a password and tick *Auto confirm*. It becomes `platform_owner` automatically and is **not** added to Wayne's staff.
3. After Vercel deploys, check:
   - Sign in as `hanafymedia@gmail.com`. You land on `/platform`, and Dashboard, Businesses and Wayne's Pizza load.
   - Wayne's Pizza → Services: every service shows *enabled*. Try changing CRM to *disabled*: it should refuse ("Turn off Automations, SMS first"). Leave it.
   - "Enter Wayne's Pizza as Hanafy support" with a reason. The black banner appears on `/w/waynes-pizza` and `/admin`. End the session and access is gone.
   - Sign in as Ehab: `/platform` shows 404. Admin → Audit shows "Hanafy support session started … (Hanafy)".

## 7. Acceptance checklist

| Requirement | Result |
|---|---|
| Platform dashboard | ✅ |
| Workspaces list | ✅ |
| Workspace detail | ✅ |
| Services tab (enable/disable, custom contract, dates, why it's on, dependency protection) | ✅ |
| Users tab | ✅ |
| Health / audit summaries | ✅ |
| An authorised Hanafy platform user can manage Wayne's workspace | ✅ (DB tests and live probe) |
| An ordinary Wayne's owner cannot access Platform Admin | ✅ (DB 404 guard, RPCs refuse, live check) |
| §8.4 audited support mode, no invisible impersonation (Scenario F) | ✅ |
| Production build verified | ⏳ Mac `npm run verify` |

## 8. Known limitations / deferred

- **Billing, plans and equipment balances** show "Phase 11"; nothing is billed.
- **Messaging usage, opt-outs and registration status** move into Platform Admin with the CRM in Phase 7. The CRM is still a separate Supabase project.
- **Per-device health and last-seen** come with Phase 10. Health shows registers, caller lines, print jobs and the last ring today.
- **Workspace status changes** (suspend or archive) are deliberately not in the console yet. §39 asks for explicit business rules first.
- Managing the **platform team** itself (inviting Hanafy staff) still uses `platform_user_invites` in SQL; a screen can follow.
- The support banner shows times on Wayne's clock (America/New_York) on `/admin` and the POS screens; `/w` uses the business's own timezone.
- Legacy Wayne-only functions, global unique constraints and single-column foreign keys remain (Phase 5 note). Don't add a second real business until the "scope legacy RPCs" phase.

## Next

**Phase 7: tenantize Hanafy CRM and messaging.** Not started; it waits for your go-ahead.
