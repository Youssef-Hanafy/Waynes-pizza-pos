# Hanafy Platform: Phase 9 completion report (integration registry + payment connectors)

**Date:** 2026-09-28
**Builds on:** Phase 8
**Migration:** `20261011080000_phase9_integrations_payment_connectors.sql`
**Status:** **Phase 9 passed** (database acceptance proven by tests; typecheck + lint clean), subject to `npm run verify` on the Mac.

## 1. What was built

| Area | What it does |
|---|---|
| Provider catalog + capability model (§20.4/20.5) | `payment_provider_catalog`: **External terminal (manual)** – available; **Square** – available (Web Payments + Terminal API code already existed); **Worldpay** – *planned*. Each lists its connection modes and capabilities (online card, card at counter, POS-driven reader, manual confirmation, refunds/voids via API, webhooks). A planned provider can be recorded but can never be pending or connected. |
| Integration registry (§24) | `integration_connections`: every external connection per workspace/location with type, provider, status, last success, last error. Payment and messaging connections keep their registry row in step automatically; the old CRM event bridge and the caller-ID bridge are listed too. |
| Payment connections (§20.2) | `payment_connections`: purpose (counter / online / both), provider, mode, status, environment, merchant reference, capabilities (**copied from the catalog, never from a client**), public configuration, `env:` **secret reference** (never a secret), per-connection webhook key, verification. **Nothing is shown "connected" without a recorded, successful provider test**, and changing the setup clears the verification. One live connection per location and purpose. |
| Terminals (§20.3) | `payment_terminals` gained `payment_connection_id`, `terminal_type` (`provider_reader` / `external_manual`) and `hardware_device_id` (Phase 10). The POS only ever lists `provider_reader` terminals as chargeable. |
| Wayne's | Counter = **External terminal (manual), merchant "Boston North"**, status *manual*, with terminal "Counter card terminal (Boston North)" (external/manual). Online card = none (Granbury handles online ordering). Exactly today's behaviour. |
| No raw card data (§20.6) | `hanafy_card_data_problem` refuses card-number/CVV/track/PIN-block keys and any Luhn-valid 13–19 digit card-looking value in `payments.metadata`, `payment_webhook_events.payload`, and every payment/integration JSON column (`CARD_DATA_REFUSED`). Last four and brand are fine. |
| Adapter registry (app) | `src/lib/payments/registry.ts` is the only place that maps a provider code to processor code. `resolvePaymentProvider` now reads the workspace's connection (`hanafy_payment_connection_for`), checks capabilities (`capabilityGate`) and returns the `PaymentProvider` interface; **order, checkout and POS routes are unchanged and provider-agnostic**. A manual terminal returns "run the amount on the store's own terminal and confirm" — the POS never calls the processor. |
| Webhooks per connection | `POST /api/payments/webhooks/[key]`: the key picks ONE connection, so the business is known before the body is read, its own secret verifies it, and the event is stored against that business (`hanafy_record_payment_webhook`), once. The old host-routed `/api/webhooks/square` keeps working and now resolves through connections too. |
| Settings compatibility | Saving Square in the old Admin → Payments settings keeps a matching Square connection in step (created *pending verification*; turned off when set back to none). |
| Platform Admin | New **Payments & integrations** tab: last captured card payment, webhook problems (7 days), every payment connection (provider, purpose, mode, environment, merchant, credentials reference, tested/never, last success/error, capabilities, terminals, webhook URL), **Test connection** (a real read-only Square call; only success marks it connected; audited), turn off (reason; confirmation if it leaves the counter without a method), add a connection (reason; production asks for confirmation), all integrations, provider catalog. |
| Business Payments screen | New "How this business takes cards" card (no secrets, no webhook keys). |

## 2. Existing behaviour preserved

- Wayne's counter card flow is still the manual Boston North terminal with cash drawer kick; online card stays off.
- Square code paths are unchanged; they're now reached through the registry. `SQUARE_ACCESS_TOKEN` / `SQUARE_WEBHOOK_SIGNATURE_KEY` still work (`env:SQUARE`).
- All Phase 1–8 DB tests and the older phase tests pass with Phase 9 applied.

## 3. Files

**New:** `supabase/migrations/20261011080000_phase9_integrations_payment_connectors.sql`, `src/lib/payments/{capabilities,registry,square-webhook}.ts`, `src/lib/payments/capabilities.test.ts`, `src/app/api/payments/webhooks/[key]/route.ts`, `src/lib/platform/integrations.ts`, `src/app/platform/workspaces/[workspaceSlug]/integrations/page.tsx`, `tests/hanafy-phase9-payment-connectors.test.ts`.
**Changed:** `src/lib/payments/{config,queries}.ts`, `src/app/api/webhooks/square/route.ts`, `src/app/admin/payments/page.tsx`, `src/app/platform/actions.ts`, `src/app/platform/workspaces/[workspaceSlug]/layout.tsx`, `src/lib/platform/{queries,schemas}.ts`.

## 4. Database / RLS

- New: `payment_provider_catalog` (read for signed-in users), `integration_connections` (members with `integrations.manage` or `payments.manage` read their own workspace), `payment_connections` (**no direct reads at all** – it holds the webhook key; screens use RPCs).
- Service-role only: `hanafy_payment_connection_for`, `…_by_webhook_key`, `…_record_check`, `hanafy_record_payment_webhook`.
- Platform: `hanafy_platform_workspace_integrations`, `hanafy_platform_save_payment_connection` (owner/admin, reason, confirmations, both audit logs). Business: `hanafy_payment_connections_summary` (`payments.manage`).

## 5. Tests and verification (Phases 7–9)

| Check | Result |
|---|---|
| `tests/hanafy-phase9-payment-connectors.test.ts` (7) | **pass** |
| All 34 DB test files, real PGlite from your `node_modules` (Linux VM on your Mac) | **pass** except 3 cases in `phase5-database` that use `expect.any` (my test runner lacks it; unrelated to these phases) — confirm with `npm test` |
| Same DB tests on PostgreSQL 16 | **pass** |
| Unit tests: sigv4 (AWS published vector), messaging, capabilities, automations form, tenancy navigation/services, platform schemas | **pass** |
| `tsc --noEmit` (whole project) | **0 errors** |
| `eslint . --max-warnings=0` (whole project) | **0 problems** |
| `next build`, Playwright | run `npm run verify` / `npm run test:e2e` on the Mac |

Acceptance: Wayne's is configured with a provider and mode (manual external, Boston North) without order code being provider-specific; two test businesses with different providers resolve only their own (Scenario C), even when asked with the other's location; planned providers can't go live; "connected" needs a real test; raw card data is refused.

## 6. Manual steps

None for Wayne's today. When a business gets an API processor (e.g. Square):
1. Server env `PREFIX_ACCESS_TOKEN`, `PREFIX_WEBHOOK_SIGNATURE_KEY`.
2. Platform Admin → Payments & integrations → add Square with `env:PREFIX`, application id, location id, and the per-connection webhook URL shown on the card as the Square notification URL.
3. **Test connection** → connected. Then switch card payment on in the business's Payments screen.

## 7. Known limitations

- Worldpay and other processors are catalogue entries only.
- `wayne_settle_payment` still matches by provider payment id across the platform (ids are globally unique per provider); scoped legacy RPCs are the "scope legacy RPCs" phase.
- Boston North terminal integration (sending the amount to it) waits on Boston North's answer about an API; until then it is manual by design.

## Next

**Phase 10: hardware/device administration.** Not started; waits for your go-ahead.
