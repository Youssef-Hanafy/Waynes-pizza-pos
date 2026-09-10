# Phase 5 Completion Report — Kitchen/KDS + Print Queue

Date: 2026-09-09

## What was built

- A permission-protected, responsive `/kitchen` board with oldest-first tickets, live Supabase changes, five-second recovery polling, reconnect/visibility refresh, connection status, and a stale-data safety lock.
- Restricted kitchen ticket projections containing only the operational data needed to prepare an order. Customer contact/address, public access tokens, and payment fields are excluded.
- Atomic, audited `placed → accepted → in_kitchen → ready` transitions. Duplicate submits are safe; stale screens are rejected and refreshed.
- Pickup/delivery distinction, large order numbers, item variants, modifier group/choice details, per-item/order instructions, station labels, and placed/accepted elapsed timers.
- Database-backed `print_jobs` records with immutable station ticket snapshots, one job per order/station, leases, acknowledgements, definite offline failures, inspected retry, and visible admin exception handling at `/admin/printing`.
- A printer adapter/worker interface that deliberately has no fake success path. Ambiguous hardware outcomes are held for reconciliation instead of automatically reprinting.
- A trusted-agent Supabase queue repository bridge. It uses the worker's authenticated account and database permission checks; it never puts service-role credentials in a browser.

## Files added or changed for Phase 5

- `docs/PHASE_5_PLAN.md`
- `docs/PHASE_5_COMPLETION_REPORT.md`
- `supabase/migrations/20260909050000_phase5_kitchen_printing.sql`
- `supabase/tests/006_phase5_kitchen_printing.test.sql`
- `tests/phase5-database.test.ts`
- `src/app/kitchen/page.tsx`
- `src/app/kitchen/kitchen-board.tsx`
- `src/app/api/kitchen/route.ts`
- `src/app/admin/printing/page.tsx`
- `src/app/admin/printing/actions.ts`
- `src/lib/kitchen/schemas.ts`
- `src/lib/kitchen/queries.ts`
- `src/lib/printing/adapter.ts`
- `src/lib/printing/worker.ts`
- `src/lib/printing/worker.test.ts`
- `src/lib/printing/schemas.ts`
- `src/lib/printing/queries.ts`
- `src/lib/printing/supabase-repository.ts`
- `src/lib/auth/permissions.ts`
- `src/app/admin/layout.tsx`
- `src/app/admin/page.tsx`

## Database changes

New Phase 5 migration: `20260909050000_phase5_kitchen_printing.sql`.

It adds `kitchen_tickets`, `print_jobs`, print-management permissions, the `in_kitchen_at` order timestamp, immutable item routing snapshots, RLS policies, realtime publication membership, and the kitchen/printing RPCs.

The live **Waynes Pizza POS** Supabase project (`vxpkdmtornkeoedkawkt`) was missing Phases 2–4 as well. I applied its committed Phase 2, 3, 4, and 5 migrations there successfully. No Hanafy Media website or other Supabase project was changed.

Live checks confirmed the kitchen functions/tables exist and the existing owner has `orders.view`, `kitchen.access`, `printing.manage`, and `printing.process`. This resolves the calendar access issue for the owner account.

## Environment and owner setup

No new environment variables are required for the KDS or durable queue. The existing required application variables remain:

- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — server-only; never expose it to a browser.

Before physical printing is enabled, choose the printer model/connection and run a trusted local print agent with an authenticated staff account that has `printing.process`. Do not use a service key in a browser or a public device.

## Automated verification

Executed successfully:

```text
npm run lint       PASS
npm run typecheck  PASS
npm run test       PASS — 24 files, 142 tests
npm run build      PASS
```

Phase 5 tests cover online and POS ticket publication after commit, modifier/routing snapshots, restricted kitchen data, reload recovery, authorization boundaries, transitions/timestamps/audit events, print leases, expired lease inspection, durable failures, retries, rollback behavior, and the printer worker's offline/timeout/acknowledgement-loss behavior.

`supabase/tests/006_phase5_kitchen_printing.test.sql` and `007_phase0_5_special_hours.test.sql` are included for transactional pgTAP runs; they roll back their fixtures. The staging-only Playwright vertical-slice suite now also creates online/POS orders and reconciles their KDS/print-queue records when explicitly configured.

## Exact manual verification steps

1. Sign in as the owner and visit `/admin/calendar`; confirm it opens rather than showing an owner-access error.
2. In a second browser/device, sign in as a kitchen-role staff account and open `/kitchen`.
3. Create a real test/manual order from `/pos` or the online checkout using a clearly marked test item/order note.
4. Confirm the ticket appears on `/kitchen` within a few seconds with the correct fulfillment type, items, modifiers, instructions, and route.
5. Refresh the kitchen screen, briefly disconnect/reconnect its network, and confirm the same current ticket is restored.
6. Tap **Accept order**, **Start cooking**, then **Mark ready**. Confirm pickup displays “Ready at the counter” and delivery displays “Ready for driver pickup.”
7. Open `/admin/printing`; confirm the station job exists. With no agent/printer configured it should remain pending, not falsely show printed.
8. When a real print agent is configured, turn its printer offline before submission; confirm the job is retained as failed, inspect the printer, enter a retry reason, then retry and confirm the attempt count increases.

## Known limitations / deferred items

- There is no physical printer selected or connected yet. The adapter and durable queue are complete, but hardware-specific ESC/POS/network printing is intentionally deferred until the printer is chosen.
- The board uses one logical station by default, while its persisted per-item route and per-station jobs are ready for later multi-station configuration.
- A live production order was not fabricated solely for verification, so the final real-device KDS/printer walkthrough above remains owner-operated acceptance evidence.

## Acceptance checklist

| Requirement | Status |
| --- | --- |
| Online and POS orders reach KDS within seconds | Automated database integration passes; live owner walkthrough pending. |
| Refresh/reconnect restores current tickets | Implemented and automated database recovery check passes; live walkthrough pending. |
| State transitions persist | Passes automated transition/timestamp/audit tests and live schema verification. |
| Printer failure never loses the order | Passes durable queue and worker failure tests. |
| Failed print job can be retried | Passes automated retry/lease tests and admin retry UI is live. |

Phase 5 implementation, migration deployment, and automated checks are complete. The phase should be formally signed off after the owner runs the live manual KDS/printer walkthrough above; a physical printer cannot be accepted until one is selected and connected.

The next phase is Phase 6 (dashboard and core reports). It has not been started.
