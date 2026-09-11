# Phase 8 — Wayne's → Hanafy Event Integration

## Delivered

- A transaction-safe Supabase outbox and immutable delivery-attempt log.
- Versioned event envelopes with a UUID `event_id`, business ID, source, event type, occurrence timestamp, and customer/segment properties.
- Enqueue triggers for customer lifecycle, consent, metric/segment events, and order-created/paid/completed/cancelled transitions. Hanafy availability never participates in the order transaction.
- A worker-only Next route that claims a leased event, HMAC-signs the exact timestamp/body, delivers it over HTTPS, writes a success/failure log, and uses capped exponential backoff.
- Owner/manager integration dashboard for endpoint configuration, health counts, recent event diagnosis, and explicit replay. Replays retain the original `event_id`, making duplicate processing safe for Hanafy's idempotency store.
- Signing-secret rotation retains the prior secret for seven days.

## Required deployment configuration

1. Set `INTEGRATION_WORKER_TOKEN` to a high-entropy secret in the deployed Wayne's environment.
2. Configure a scheduler to POST `Authorization: Bearer <INTEGRATION_WORKER_TOKEN>` to `/api/integrations/hanafy/worker` at least every minute. The endpoint processes up to 25 due events each call.
3. Open `/admin/integrations` as an owner/manager, set the Phase 9 Hanafy HTTPS ingestion endpoint and a separate 32+ character HMAC signing secret.
4. Hanafy must validate the `x-waynes-timestamp` replay window, verify `x-waynes-signature` against `<timestamp>.<raw body>`, and idempotently store `event_id` before starting automation work.

## Verification

- Phase 8 database tests cover atomic envelope creation, persisted failed attempts, backoff/replay identity, and access boundaries.
- HMAC unit tests cover timestamp-bound signatures and worker-token comparison.
- A successful worker run or an explicit retry should be visible in `/admin/integrations`; no order path waits on Hanafy.

## Intentional boundary

Phase 8 delivers signed events only. Hanafy's endpoint, incoming-event deduplication, and automation execution are Phase 9 work, so no outbound destination is preconfigured with a guessed endpoint or secret.
