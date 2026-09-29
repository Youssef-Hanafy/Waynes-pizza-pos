# Hanafy Platform: Phase 12 completion report (Add Business provisioning flow)

**Date:** 2026-09-29
**Builds on:** Phase 11
**Migration:** `20261014080000_phase12_add_business_provisioning.sql` (applied to live Supabase)
**Status:** **Phase 12 passed** (database acceptance proven by tests; typecheck + lint clean), subject to `npm run verify` on the Mac.

## 1. What was built

| Step (§25) | Where | What happens |
|---|---|---|
| 1 Business details | `/platform/workspaces/new` | Name, web name (slug; reserved names like `platform`, `admin`, `new` refused), legal name, type, time zone (validated), currency, primary contact. Created in **provisioning**. "Test workspace" box (default on); a real client needs an explicit "this was authorized" tick. |
| 2 First location | same form | Name, address, phone, email, time zone, opening/closing time and closed days → location (provisioning), its website settings, hardware settings (simulator, nothing connected), payment settings (none). |
| 3 Services | same form | Only the ticked services are switched on; requirements enforced (SMS/Email/Automations need CRM, Caller ID needs POS, Delivery needs POS or online ordering). |
| 4 Owner account | Setup → Users tab | Existing audited "add user" flow (creates the sign-in with a temporary password). Checklist confirms the owner exists, email confirmed, and their permissions come only from this business's services. |
| 5 Messaging | Setup → Messaging tab | Required only if SMS is on: an active SMS number. |
| 6 Payment | Setup → Payments & integrations | Any connection not yet tested blocks go-live; none at all = "cash only" (allowed). |
| 7 Hardware | Setup → Hardware tab | Caller ID on → a caller-ID box must be recorded and serving a line. Devices reporting a problem are flagged. |
| 8 Data import | checklist (optional) | Shows customer and menu counts. A bulk import screen is not built yet (see limitations). |
| 9 Checklist | `/platform/workspaces/<slug>/setup` | Every line is recomputed from real records on each load; each failing line links to the tab that fixes it. Web address required when the website or online ordering is on. Hanafy agreement shown as a reminder. |
| 10 Activate | Setup tab | Button appears only when every required line passes; real clients get a confirmation. Locations move from provisioning to active with it. |
| Suspend / archive (§39) | Setup tab | Reason + confirmation for anything live; archiving turns web addresses off and keeps records; an archived business can't be reopened here; **Wayne's can never be archived.** |

All changes are audited (`platform.workspace.provisioned / activated / suspended / archived`). Only platform owners/admins can create or change status.

## 2. Acceptance

- A developer can create a temporary test workspace **without writing SQL** (form → one audited RPC).
- It receives **only the selected modules**: `workspace_services` holds exactly the ticked services; the owner's `hanafy_current_workspace_access` returns those services only; they can't open Wayne's and see none of Wayne's orders (test).
- Nothing was created in live Supabase for a new client (per §0). Wayne's passes every checklist line today.

## 3. Tests

| Check | Result |
|---|---|
| `tests/hanafy-phase12-provisioning.test.ts` (5) | **pass** |
| `src/lib/platform/provisioning.test.ts` (2) | **pass** |
| `tsc --noEmit` / `eslint` | **0 errors / 0 problems** |

## 4. Manual test

1. `/platform/workspaces` → **Add business** → fill a test deli with POS + CRM → Create.
2. Setup tab shows "Owner account: Needed" → Users tab → add owner with a temporary password → Setup: Done.
3. **Activate** → it appears as active on the dashboard. Then Suspend → Archive to clean it up.

## 5. Known limitations

- No bulk customer/menu import screen yet (step 8 is informational). Menus are built in the business's Admin → Menu; customer CSV import with preview/dedupe is a follow-up.
- The owner's temporary password is shared by hand; no invitation email is sent.

## Next

Phase 13: multi-tenant storefront / custom domain layer.
