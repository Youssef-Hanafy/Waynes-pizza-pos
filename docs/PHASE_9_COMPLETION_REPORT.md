# Phase 9 — Hanafy CRM Automation Engine (completion report)

**Date:** 2026-09-11 · **Status:** acceptance criteria passed on the live systems.

## What changed and why

The first Phase 9 attempt built a second automation engine inside the Hanafy
*marketing site* (Vercel). It could queue messages but not send them, kept its
own opt-out list separate from the CRM's STOP handling, and read Wayne's consent
fields under the wrong names (every customer looked opted out). The build sheet
requires automations to use the existing Hanafy CRM, its AWS SMS layer, and one
shared suppression list, so Phase 9 was moved into the real CRM
(`hanafy-retention-v1`, Cloudflare Worker `hanafy-media-crm`, `hanafymedia.com/admin/crm`)
and the duplicate engine was retired.

## Built

### Wayne's POS (`waynes-pizza-pos`)
- `20260913080000_phase9_outbox_database_delivery.sql`
  - Supabase delivers the outbox itself: `pg_cron` job `wayne-hanafy-outbox-delivery`
    runs every minute; `pg_net` POSTs each event, signed in Postgres with the same
    HMAC as the Next worker; a collector records every HTTP result.
  - Fixed Phase 8 defect: events whose worker died mid-delivery stayed
    `processing` forever. Expired leases are now reclaimed and the lost attempt logged.
  - Segment enter/exit events now include `segment: {id, name}`.
  - Fixed Phase 8 defect: `wayne_customer_hanafy_properties` (returns a customer's
    contact details) was callable through the public API. Revoked.
- Destination set to `https://www.hanafymedia.com/api/v1/integrations/waynes/events`
  with a new shared secret.

### Hanafy CRM (`hanafy-retention-v1`)
- `POST /api/v1/integrations/waynes/events`: HMAC + ±5-minute replay window,
  per-business secret with 7-day rotation grace (`crm_signed_event_sources`).
- Each `event_id` recorded once (`crm_events.idempotency_key = waynes-pos:<id>`);
  duplicates return 200 and create nothing.
- Contact sync from Wayne's authoritative facts (name, phone, email, order count,
  lifetime value, AOV, last order). Consent changes only when Wayne's sends it;
  **STOP / suppression always overrides a Wayne's opt-in**; changes logged to
  `crm_consent_records`. Contacts are found-or-created under a per-customer lock
  (`crm_claim_waynes_contact`), and older events can't overwrite newer facts.
- Wayne's segments mirrored as tags `waynes-segment:<slug>` for Campaign Manager.
- Automation runner: triggers *Customer enters / leaves a Wayne's POS segment*
  (optional segment name), suppression-list check before every SMS (run cancelled
  as `sms_suppressed`, not failed), per-step SMS idempotency key.
- Campaign Manager untouched.

### Marketing site (`hanafy-media-phase1`)
- Removed the duplicate intake/worker routes and admin page; sidebar links to `/admin/crm`.
- `20260913090000_retire_phase9_marketing_site_engine.sql`: old cron job removed,
  intake disabled, workflows paused, RPCs revoked, leftover `automation_*` tables
  readable by platform admins only (previously any signed-in user could read/write them).

## Commits
- waynes-pizza-pos: `9613fe6`, `331dd4b` (+ this report)
- hanafy-retention-v1: `f6fb9ea` (baseline — folder had no git history), `057a005`, `4a94c57`
- hanafy-media-phase1: `74475e0` (pushed), `09ca5ee`

## Environment / setup
- No new env vars. The CRM uses its existing `SUPABASE_SERVICE_ROLE_KEY` Cloudflare secret.
- Deploy the CRM with `npm run deploy:cloudflare` from `hanafy-retention-v1`.
- Rotate the shared secret: CRM `crm_rotate_signed_event_secret(...)` then Wayne's
  Admin → Integrations with the same value.

## Automated tests
- Wayne's `tests/phase9-outbox-delivery.test.ts` (signature parity with the Next
  worker, stale-lease reclaim, pg_net dispatch/collect for 2xx and 5xx, segment
  name, privileges) — all passed against PGlite. Run `npm test` on the Mac for the full suite.
- CRM `tests/waynes-protocol.test.ts` — 7/7 passed (signature, replay window,
  envelope validation, field mapping, consent/segment semantics). `tsc` + ESLint clean.

## Live acceptance results (2026-09-11, test data since deleted)
| Build-sheet criterion | Result |
| --- | --- |
| A test `customer.segment.entered` event creates exactly one run | ✅ one run, dedupe key `crm:<event>` |
| Matching workflow executes | ✅ live "VIP" workflow ran, tag applied |
| Non-matching workflow does nothing | ✅ "High spender" and Text Club events started nothing |
| Paused / draft workflow does nothing | ✅ no runs |
| Duplicate event does not duplicate send | ✅ retried event → HTTP 200 `duplicate: true`, no new run |
| Opted-out customer is suppressed | ✅ run cancelled `sms_suppressed: Number is on the suppression list (stop)`, 0 messages |
| STOP overrides a later Wayne's opt-in | ✅ consent kept off, reason recorded on the event |
| Run history explains every decision | ✅ `sms_automation_events`: run_started → trigger_matched → sms_suppressed / add_tag_completed |
| Wayne's keeps working if Hanafy is down | ✅ by design: failed deliveries back off and retry (Phase 8) |
| New customer not split across contacts | ✅ after fix (bug found and fixed during live testing) |

## Known limitations / deferred
- STOP texted to the CRM is not yet written back to Wayne's `sms_marketing_opt_in`
  (the CRM blocks sends; Wayne's checkbox just doesn't reflect it).
- Quiet hours / send windows and "wait" steps need a scheduler calling
  `/api/crm/triggers/run`; none is configured yet. Segment-triggered immediate
  sends work today.
- The email action is logged but not delivered (no email provider wired in the CRM yet).
- Pre-existing CRM advisories: several `sms_*`/`crm_*` SECURITY DEFINER functions are
  callable by anon; leaked-password protection is off. Not changed in this phase.
- Re-enable Vercel Deployment Protection on the marketing site (the previous agent disabled it).

## Next phase
Phase 10 — Delivery Driver Module. Not started; waiting for approval.
