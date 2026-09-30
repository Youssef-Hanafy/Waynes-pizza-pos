# Hanafy Platform conversion — Phase 0 audit

**Date:** 2026-09-29

## Outcome to preserve

Hanafy needs one control panel. A Hanafy platform user should select Wayne's Pizza and then manage its sales, orders, menu, hardware, payments, staff, CRM, campaigns, and automations. A future business must receive its own workspace within that same platform, not a cloned application.

```text
Hanafy Platform
├── Platform Admin — Hanafy staff; workspaces, services, users, health
└── Wayne's Pizza workspace
    ├── Sales, orders, POS, kitchen, delivery and cash
    ├── Menu, promotions, staff, settings, payments and hardware
    └── CRM, campaigns, SMS and automations
```

Wayne's staff must see only Wayne's data. The existing Campaign Manager and CRM must remain available; no replacement marketing system should be built in the POS.

## Current architecture

### This checkout

This checkout is a dedicated Wayne's Pizza POS project (`package.json` is named `waynes-pizza-pos`). It contains the public store, checkout, POS, kitchen, delivery, cash drawers, payments, printing, the `/admin` sales dashboard, reports, orders, customers, menu, promotions, staff, settings, integrations, and audit log.

The sales dashboard is authoritative and exists at `/admin` in this codebase. It is not reachable from the current Hanafy Media Vercel URL because that deployment is serving a different application.

### CRM and former all-in-one application

Repository history at `main` retains the prior Hanafy Retention Platform source. It contained `/admin/crm`, contacts, audiences, campaigns, SMS identities, CRM event ingestion, imports, automation workflows, and business membership through `sms_businesses` and `sms_business_members`.

The current checkout does not include the live CRM or Hanafy Media site-admin source. The Phase 9 report identifies the CRM as the separate Cloudflare worker `hanafy-media-crm`, served at `hanafymedia.com/admin/crm`. The live CRM repository, marketing-site repository, deployments, and database state must be checked before CRM changes in Phase 7. Git history is evidence, not proof of current production state.

### POS-to-CRM integration

Wayne's writes orders and customer facts locally, then database triggers enqueue signed retryable events in `integration_outbox` for the CRM. This must stay asynchronous: CRM, SMS, or automation outages must never stop ordering.

The event envelope currently has a hard-coded CRM-facing `business_id` of `waynes-pizza`. It must become a canonical workspace/location contract only after both systems support it.

## Current data and access model

| Area | Current Wayne's POS tables |
| --- | --- |
| Identity | `profiles`, `roles`, `permissions`, `role_permissions` |
| Store/menu | `store_settings`, `store_special_hours`, `menu_categories`, `menu_items`, variants and modifiers |
| Customers | `customers`, `customer_addresses`, `marketing_consents`, segments, memberships and events |
| Orders | `orders`, items, modifiers, discounts, events and idempotency records |
| Operations | kitchen tickets, print jobs, delivery assignments, registers, shifts and cash movements |
| Payments | `payments`, `refunds`, provider settings, terminals and webhook events |
| Integration | destinations, outbox, delivery logs, audit log and application errors |

The current POS is a good single-business system, but no tenant-owned table has `workspace_id` or `location_id`. It assumes one `store_settings` row, globally unique customer phone numbers, global order numbers, and Wayne-prefixed functions.

The former CRM has an existing business-scoped model: `sms_businesses`, `sms_business_members`, contacts, segments, campaigns, message jobs, SMS identities, automation runs, CRM events, consent/suppression, imports, and platform-admin records. That model must be migrated or mapped to a canonical workspace identity rather than duplicated.

Wayne's currently uses Supabase Auth plus one `profiles` role per user. `wayne_my_access()` and `wayne_has_permission()` enforce permissions; protected routes include `/admin`, `/pos`, `/kitchen`, and `/driver`. The existing RLS suite verifies the single-business boundary, but cannot prove cross-workspace isolation because no second workspace exists.

## Assumptions to remove from code

- Wayne's name, logo, colors, rewards copy and storefront URLs.
- The `waynes-pizza` integration ID and Wayne-specific event headers.
- One business's timezone, address, phone, hours, tax, delivery area, fees, receipts and ordering policy.
- Wayne's menu seed data and food-specific language.
- Global customer-phone uniqueness and global order-number sequencing.
- Profiles that cannot belong to several workspaces.
- Unscoped payment settings, terminals, reporting, print jobs, storage and hardware.

## Concepts to reconcile

| Concept | POS | CRM | Target |
| --- | --- | --- | --- |
| Customer | `customers` with order metrics | `sms_contacts` | One workspace-scoped canonical identity with a safe compatibility mapping |
| Consent | opt-in flags and `marketing_consents` | consent records and suppressions | One auditable policy; STOP stays authoritative |
| Segments | customer segments/memberships | CRM segments/tags | Preserve both operational and marketing use without double evaluation |
| Events | customer events/outbox | CRM events/automation runner | One workspace-aware, idempotent asynchronous event path |
| Access | profiles and Wayne roles | business members/platform admins | Workspace membership plus separate platform roles |
| Business settings | singleton store settings | business profile | workspace settings plus location settings |

## Risks and controls

1. **Data leakage:** Do not add a real client before scoped data, RLS, and two-workspace denial tests pass.
2. **Sales integrity:** Add nullable scope columns, backfill, validate totals, then make them required. Preserve all order, payment, refund, shift and audit snapshots.
3. **CRM duplication:** Use existing CRM external IDs, consent evidence, locks and suppression records; do not bulk-copy contacts blindly.
4. **Integration downtime:** Keep the current outbox adapter during migration and never make checkout wait for CRM.
5. **Deployment mismatch:** Do not overwrite or redirect the current Hanafy Vercel app. Verify the actual marketing-site, CRM-worker, POS, and Supabase projects first.
6. **Existing local work:** The pre-existing dirty menu/config files and `20260919080000_specialty_pizza_recipes.sql` were not touched.

## Proposed Phase 1 — not started

1. Add a forward-only migration, proposed as `20260920000000_platform_tenancy_foundation.sql`.
2. Create `workspaces`, `locations`, `workspace_members`, `workspace_invites`, `platform_users`, `service_catalog`, and `workspace_services` with indexes, RLS, and server-trusted helper functions.
3. Seed only Wayne's Pizza and its first location. Seed the service catalog; do not create real prospects or customers.
4. Add typed, server-only workspace-context and service-entitlement helpers under `src/lib/tenancy/`. Do not alter ordinary Wayne's routes yet.
5. Add temporary two-workspace database tests that prove users cannot read, write, promote themselves into, or subscribe to another workspace.
6. Run the complete migration, test, typecheck, lint and build suite. Stop before backfilling POS data.

## Current conflicts with the desired platform

- The current checkout is a Wayne's-only POS, while the desired product is a shared Hanafy Platform.
- The actual Hanafy deployment and live CRM source are outside this checkout.
- The old CRM ownership field is `business_id`; the new platform must avoid supporting competing `business_id` and `workspace_id` models permanently.
- The current Hanafy domain does not route to the rebuilt Wayne's admin.

## Phase 0 completion

- [x] Wayne's application, schema, roles, RLS, integrations and tests mapped.
- [x] Prior CRM source and its business-scoped model identified.
- [x] Existing CRM ownership and the POS-to-CRM event boundary identified.
- [x] Wayne-specific constants, duplicate concepts, risks and a Phase 1 plan recorded.
- [x] No schema, application, deployment, or live-data changes made.

**Status: passed.** The next phase is Core tenancy schema. It must not start until this audit is approved and the actual Hanafy Media marketing-site, CRM-worker, POS, and Supabase projects are identified.
