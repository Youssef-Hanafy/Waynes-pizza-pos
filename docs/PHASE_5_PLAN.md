# Phase 5 work plan

Authorized scope: Kitchen/KDS and print queue abstraction, following sections 13 and 34 of the master build sheet.

1. Inspect previous migrations and order entry points; preserve the canonical order model.
2. Add a restricted kitchen ticket projection, live change notifications, and atomic Accept → Start → Ready transitions with staff audit events.
3. Add persistent print jobs with immutable ticket snapshots, station routing, leases, acknowledgement, failure visibility, and audited retry.
4. Build `/kitchen` with oldest-first tickets, pickup/delivery labels, item/modifier notes, elapsed timers, connection health, and refresh/reconnect recovery.
5. Add the printer adapter and worker contract; defer physical hardware integration until hardware is selected.
6. Test order-to-kitchen/queue integration, access controls, duplicate transitions, refresh recovery, offline printers, and safe retry. Run all tests, lint, typecheck, and production build.
7. Verify hosted migration state and apply only missing Wayne's migrations when access allows; record actual hosted acceptance results.
8. Deliver the completion report with exact manual test steps and remaining setup. Do not begin Phase 6.

Status: implementation and Wayne's production migration deployment complete. Automated verification passed; owner-operated live KDS/printer walkthrough remains the final acceptance evidence because no physical printer is configured.
