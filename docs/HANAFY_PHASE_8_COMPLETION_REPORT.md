# Hanafy Platform: Phase 8 completion report (unified events and automations)

**Date:** 2026-09-28
**Builds on:** Phase 7
**Migration:** `20261010080000_phase8_events_automations.sql`
**Status:** **Phase 8 passed** (database acceptance proven by tests), subject to `npm run verify` on the Mac.

## 1. What was built

| Area | What it does |
|---|---|
| Domain events (§18.1) | `domain_events` holds the build-sheet envelope: `event_id` (unique), workspace, location, type, occurred_at, source module, version, subject type/id, customer, data. A trigger on `integration_outbox` writes it **in the same transaction** as the order/customer change, so the POS keeps its outbox reliability, the old CRM bridge is untouched, and ordering never waits on marketing. A customer id that isn't that workspace's customer is dropped, never trusted. The 32 historic outbox events were recorded as `skipped` so history never fires automations. |
| Automations (§17.2/17.3) | `automations` (workspace, status draft/active/paused/archived, executor) + **immutable** `automation_versions` (trigger + filters, up to 10 conditions, delay, 1–5 actions, cooldown hours, once-per-customer). Saving always makes a new version; runs keep the version they started with. |
| Runs and idempotency (§18.4) | `automation_runs` is **unique per (automation, event)**: a duplicate, retried or replayed event cannot create a second run. Each action step is unique per run and its text uses idempotency key `automation:<run>:<step>`, so re-executing a run never sends twice. |
| Explainable log | `automation_run_log` says in plain words what happened: matched, "did not run: condition not met: sms_marketing_opt_in = true (was false)", "filter mismatch … needs segment X", cooldown, duplicate event, each step's result (text queued / not sent: no_consent / tag added). |
| Worker | `hanafy_automation_tick()` runs every minute on pg_cron (`hanafy-automation-tick`). It matches only automations **of the event's own workspace**, re-verifies the workspace before every action, sends texts only through Phase 7's `hanafy_enqueue_message` (consent, STOP, sender, service all re-checked). |
| Actions | Send text (marketing or transactional), add tag, remove tag (new `customer_tags`). Email waits for an email provider. |
| Service policy | If Automations is off for a business, new events are marked skipped (no flood of stale texts later) and runs already waiting stay paused and resume when it's switched back on. |
| Wayne's | The three CRM automations ("Text club welcome" live, "30-day win-back" draft, "Weekly Rewards offers" draft) are mirrored with `executor = legacy_crm`, so the platform never runs them; the old CRM still does. A texting automation can't be switched on while Wayne's texts go out from the CRM. |
| Cut-over | Platform Admin → Messaging → "Move old-CRM automations to the platform" (owner/admin, reason, confirmation, audited; only once the business's messaging is on the platform sender). |
| Workspace UI | **Admin → Automations**: list with 30-day run counts, builder (Trigger → Conditions → Timing → Actions), per-automation page with on/pause/archive, every run with its steps, the plain-language log, versions, and an audited "replay an event". Recent events list with copyable ids. |
| Permissions | `automations.view`, `automations.manage` (service `automations`; owner + manager; `marketing_readonly` and Hanafy read-only support can view). |

## 2. Existing behaviour preserved

- Outbox delivery to the CRM is unchanged (one extra `AFTER INSERT` trigger that only writes `domain_events`).
- Wayne's welcome text still comes from the CRM; nothing new is sent for Wayne's by the platform.
- Phase 1–7 DB tests re-run green.

## 3. Files

**New:** `supabase/migrations/20261010080000_phase8_events_automations.sql`, `src/lib/automations/{schemas,queries,schemas.test}.ts`, `src/app/admin/automations/{page,actions,automation-form}.tsx|ts`, `src/app/admin/automations/[automationId]/page.tsx`, `tests/hanafy-phase8-events-automations.test.ts`.
**Changed:** `src/lib/auth/permissions.ts`, `src/lib/tenancy/{services,navigation}.ts` (+ tests), `src/app/admin/layout.tsx`, `src/app/platform/actions.ts`, `src/app/platform/workspaces/[workspaceSlug]/messaging/page.tsx`, `src/lib/platform/schemas.ts`.

## 4. Database / RLS

New tables `domain_events`, `customer_tags`, `automations`, `automation_versions`, `automation_runs`, `automation_run_steps`, `automation_run_log`: RLS on, read-only for members of the same workspace (`automations.view|manage`, events also `integrations.manage`, tags also `customers.view`), no write policies. All foreign keys between them are composite `(id, workspace_id)`. `message_jobs.automation_run_id` now references its run inside the same workspace. Worker and event-recording functions are service-role only.

## 5. Tests

| Check | Result |
|---|---|
| `tests/hanafy-phase8-events-automations.test.ts` (7 cases, PostgreSQL 16, all migrations) | **pass** |
| Phase 1–7 DB tests | **pass** |
| `src/lib/automations/schemas.test.ts` | runs on the Mac (`npm test`); needs zod |

Proven: Wayne's segment-enter style event creates **exactly one** matching run; the same event recorded twice is stored once; replay, a second worker pass and re-executing the run add **no second text**; tenant B's automation on the same event type never runs for tenant A's event and vice versa; an event can't carry another business's customer; skipped runs explain the failed condition, filter mismatch and cooldown; versions are immutable; delays wait; switching Automations off pauses and switching it on resumes; members of another business see nothing; nobody but the service role can run the worker or record events.

## 6. Manual steps

None for Wayne's today. The `hanafy-automation-tick` cron job is created by the migration (pg_cron is on the live project). At cut-over: Messaging tab → switch sender to the platform → "Move old-CRM automations" → switch each automation on in Admin → Automations.

## 7. Known limitations

- Birthday/time triggers are not built yet (the build sheet marks them "later").
- Email actions wait for an email provider.
- Conditions are ANDed (up to 10); no OR groups yet.

## Next

Phase 9 (integration registry + payment connectors) — built in the same session at your request.
