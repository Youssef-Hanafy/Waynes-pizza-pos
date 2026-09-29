# Hanafy Platform: Phase 7 completion report (tenantize CRM and messaging)

**Date:** 2026-09-28
**Builds on:** Phase 6 (`ffbbe68`)
**Decision (Youssef, 2026-09-28):** build the workspace-scoped CRM and messaging model in the platform database (`vxpkdmtornkeoedkawkt`). The old Hanafy CRM (`lgbdfqpnlvjxdlalhnbk`, Cloudflare worker `hanafy-media-crm`, source on the local `main` branch of `~/Downloads/hanafy-retention-v1`) keeps sending Wayne's texts over the signed HMAC bridge until cut-over, so nothing live stops or double-sends.
**Migration:** `20261009080000_phase7_crm_messaging_tenancy.sql`
**Status:** **Phase 7 passed** (database acceptance proven by tests), subject to `npm run verify` on the Mac.

## 1. What was built

| Area | What it does |
|---|---|
| One customer record | `customers` stays the only contact record. The old CRM business is mapped to its workspace in `crm_legacy_business_links` (Wayne's → CRM business `2acaf89c…`). The CRM's single contact is already the POS customer, so no contact copies were made (§43 "no duplicate CRM contacts"). Magic Razor (archived prospect) is not migrated. |
| Sender identity (§19.1–19.3) | `messaging_connections` (one per workspace + channel: provider, status, region, 10DLC/registration, production access, **who sends**, live/simulated, `env:` secret reference, last success/error) and `messaging_origination_identities` (numbers). **A number can belong to only one business.** Sends resolve workspace → connection → number and **raise `NO_SENDER` instead of falling back**. |
| Wayne's | Connection `aws_end_user_messaging`, us-east-1, `active`, **`dispatch_mode = legacy_crm_bridge`**; number `+15136764597` (`phone-ae22e45ef42b420b8e7096b9e67daf7b`, PROMOTIONAL), copied from the CRM's `sms_aws_sending_identities`. The platform dispatcher never sends for Wayne's while this is set. |
| Consent + suppression (§19.5) | `suppression_entries` per workspace + channel. STOP/START/HELP to a platform number go through `hanafy_messaging_inbound`; the **receiving number decides the business**, so a STOP to business A never touches business B. STOP also records a `marketing_consents` opt-out and clears the customer's SMS opt-in. Ordering data is never consent. |
| Campaign Manager (§17.1) | `message_templates`, `marketing_campaigns`, `campaign_recipients`, all with composite `(id, workspace_id)` foreign keys, so a campaign cannot point at another business's segment, template, customer or number even through a raw insert. Audience = subscribers or a segment, always inside the campaign's workspace. Preview → test text (max 10, `[TEST]`) → send now or schedule → cancel. |
| Message jobs (§19.4) | `message_jobs` with workspace, customer, campaign, automation run (Phase 8), channel, marketing/transactional, sender, recipient, status, provider id/status, segments, cost, timestamps. Unique `(workspace_id, idempotency_key)`. |
| One send path | `hanafy_enqueue_message` (service role only) re-checks workspace ownership of customer, location and sender, service entitlement, consent and suppression. The dispatcher claim (`hanafy_message_jobs_claim`) checks consent/suppression/service **again** at send time. An interrupted send becomes `unknown` and is **never re-sent automatically**. |
| Dispatcher | `POST/GET /api/messaging/dispatch` (bearer `MESSAGING_DISPATCH_TOKEN` or Vercel `CRON_SECRET`). AWS End User Messaging `SendTextMessage` via a built-in SigV4 signer (verified against AWS's published example). Real texts need **both** the connection's live switch **and** `MESSAGING_LIVE_SEND=true`; otherwise sends are simulated and labelled. |
| Inbound + receipts | `POST /api/messaging/inbound`: SNS HTTPS endpoint. Only topics in `MESSAGING_SNS_TOPIC_ARNS`, only messages whose RSA signature verifies against an `sns.*.amazonaws.com` certificate. Delivery receipts are deduplicated by event id. |
| Workspace UI | **Admin → Campaigns** (`/admin/marketing`): sending number and mode, subscribers, opt-outs, campaigns, templates, opt-out list (add / remove with reason), recent texts. Campaign page: edit draft, audience preview with skip reasons, test text, send/schedule, cancel. While Wayne's is on the CRM bridge the page says so and links to the CRM console; send buttons are off. |
| Platform Admin | New **Messaging** tab: connection, numbers, usage (24 h / 30 d / simulated / failed / skipped / unknown / queued), recent failures, opt-outs, subscribers, old-CRM link. Owners/admins can change status, region, who sends, live/simulated, registration/production status, credentials reference and numbers, with a reason, recorded in both audit logs. **Switching to the platform sender or turning on live sending asks for confirmation** ("pause the CRM automations first or customers get two texts"). |
| Permissions | `campaigns.view`, `campaigns.manage`, `messaging.manage` (owned by the `sms`/`email` services; owner + manager; `marketing_readonly` gets view; Hanafy read-only support gets view). |

## 2. Existing behaviour preserved

- Wayne's texts still go out exactly as before (CRM automation "Text club welcome" over the outbox bridge). `dispatch_mode = legacy_crm_bridge` blocks platform sends for Wayne's at three layers (enqueue, campaign send, dispatcher claim).
- The CRM Campaign Manager at hanafymedia.com/admin/sms stays; the workspace nav now shows both "Campaigns" and "Hanafy CRM console".
- Phase 1–6 DB tests re-run green with Phase 7 applied.
- No existing table lost a column; three composite unique keys were added (`customers`, `locations`, `customer_segments` on `(id, workspace_id)`).

## 3. Files

**New:** `supabase/migrations/20261009080000_phase7_crm_messaging_tenancy.sql`, `src/lib/messaging/{sigv4,aws-sms,sns,dispatch,schemas,queries}.ts`, `src/lib/messaging/{sigv4,messaging}.test.ts`, `src/lib/platform/messaging.ts`, `src/app/api/messaging/{dispatch,inbound}/route.ts`, `src/app/admin/marketing/{page,actions}.tsx|ts`, `src/app/admin/marketing/campaigns/[campaignId]/page.tsx`, `src/app/platform/workspaces/[workspaceSlug]/messaging/page.tsx`, `tests/hanafy-phase7-crm-messaging.test.ts`.
**Changed:** `src/lib/auth/permissions.ts`, `src/lib/tenancy/{services,navigation,navigation.test}.ts`, `src/app/admin/layout.tsx`, `src/lib/platform/{queries,schemas}.ts`, `src/app/platform/actions.ts`, `src/app/platform/workspaces/[workspaceSlug]/layout.tsx`.

## 4. Database / RLS

- New tables (RLS on, members read their own workspace through `hanafy_can_access_workspace_data(…, campaigns.view|manage)`, **no write policies** – writes only through RPCs): `crm_legacy_business_links`, `messaging_connections`, `messaging_origination_identities`, `suppression_entries`, `message_templates`, `marketing_campaigns`, `campaign_recipients`, `message_jobs`, `message_provider_events`.
- New tenant tables have **no default-workspace trigger** (unlike the legacy tables): a missing `workspace_id` is an error, and it can never be reassigned.
- `workspace_messaging_identities` (Phase 4) is now display-only and marked deprecated.

## 5. Tests

| Check | Result |
|---|---|
| `tests/hanafy-phase7-crm-messaging.test.ts` (11 cases, all migrations on PostgreSQL 16) | **pass** |
| Phase 1–6 Hanafy DB tests, `database-foundation`, migration-integrity, phone-workflow | **pass** |
| `src/lib/messaging/sigv4.test.ts` (AWS published SigV4 vector), `messaging.test.ts` | **pass** |
| `tsc --noEmit` | see the Phase 7–9 verification note in the Phase 9 report |
| `next build`, full `vitest`, Playwright | run `npm run verify` on the Mac |

The Phase 7 test proves the acceptance criteria: two test businesses with different numbers each send only from their own number to their own customers; neither can see the other's campaigns, jobs or customers; another business's number, segment or customer is refused (and a raw insert is stopped by the composite keys); a business with no number fails with `NO_SENDER`; STOP stays inside the receiving business; consent is re-checked at send time; interrupted sends are not repeated; the same idempotency key makes one job; Wayne's jobs are never claimed while the CRM sends; SMS off → skipped; read-only staff can't send; platform changes need a reason, confirmation and are audited.

## 6. Setup (only when a business moves to the platform sender)

Nothing is required for Wayne's today. To cut a business over later:
1. Server env: `PREFIX_ACCESS_KEY_ID`, `PREFIX_SECRET_ACCESS_KEY` (IAM user limited to `sms-voice:SendTextMessage`), `MESSAGING_DISPATCH_TOKEN` (32+ chars), `MESSAGING_LIVE_SEND=true`, and for inbound `MESSAGING_SNS_TOPIC_ARNS`.
2. Schedule `POST https://<app>/api/messaging/dispatch` every minute with `Authorization: Bearer <MESSAGING_DISPATCH_TOKEN>`.
3. In AWS: two-way SMS + delivery events for the number → SNS topic → HTTPS subscription to `/api/messaging/inbound`.
4. Pause that business's live automations in the old CRM, then Platform Admin → Messaging: Who sends = Hanafy Platform, Credentials = `env:PREFIX`, Platform sending = Live (confirm).

## 7. Known limitations

- Email: no provider yet; email campaigns are refused with a clear message.
- Wayne's inbound STOP still lands in the old CRM (its number's SNS topic points there). The CRM already removes marketing consent in Wayne's through `/api/integrations/hanafy/marketing-removal`.
- Campaign audiences are all subscribers or one segment; tag audiences come with Phase 8's tags.
- The dispatcher is not scheduled yet (nothing uses the platform sender).

## Next

Phase 8 (unify event/automation architecture) — built in the same session at your request.
