# Hanafy Platform — Multi-Tenant POS + CRM + Marketing + Operations
## Master Developer / Codex / Claude Code Build Sheet

**Revision:** v1 — Multi-tenant platform conversion specification  
**Primary goal:** Convert the existing Wayne's Pizza POS + Hanafy CRM work into one reusable, secure, multi-tenant Hanafy software platform. Wayne's Pizza becomes the first real workspace/tenant. Future businesses are provisioned onto the same core software rather than receiving cloned applications.  
**Build philosophy:** Migrate carefully. Preserve working Wayne's functionality. Introduce tenancy, workspace configuration, module gating, integrations, and platform administration in controlled phases. Never attempt the entire conversion in one pass.

---

# 0. HOW A CODING AGENT OR HUMAN DEVELOPER MUST USE THIS DOCUMENT

Treat this document as a production software architecture specification, not as a loose feature request.

Before changing code:

1. Read this document completely.
2. Audit the current Hanafy Media website/admin repository, current Hanafy CRM implementation, current Wayne's POS repository/application, current Supabase schema, authentication model, integrations, and migrations.
3. Locate and read the prior Wayne's specifications if present:
   - `waynes-pizza-pos-master-build-sheet(1).md`
   - `waynes-pizza-pos-complete-build-sheet.md`
4. Do not delete or rewrite working Wayne's features merely to make them look generic.
5. Identify the currently authorized phase and implement only that phase plus the minimum interfaces needed for future phases.
6. Use committed database migrations. Never make undocumented production-only schema changes.
7. Do not create duplicate customer, order, campaign, automation, payment, hardware, or auth systems when an existing one can be migrated safely.
8. Never claim a phase is complete unless every acceptance criterion for that phase passes.
9. After each phase, stop and return a completion report before beginning the next phase.

## Required completion report after every phase

The developer/agent must report:

- What was built.
- What existing behavior was preserved.
- Files created, modified, or removed.
- Database migrations added.
- Data backfills performed.
- RLS policies created or changed.
- Environment variables or secrets required.
- Any manual configuration the owner must complete.
- Automated tests added and their results.
- Exact manual test steps.
- Known limitations or deferred work.
- A requirement-by-requirement acceptance checklist.
- Whether the phase passed.
- The next phase, without starting it unless explicitly authorized.

## Non-negotiable engineering rules

- Production-quality TypeScript. Do not use `any` as a default escape hatch.
- No fake front-end persistence for data that must survive refresh/restart.
- No raw card PAN, CVV, track data, or magnetic-stripe data stored by Hanafy.
- No Supabase service-role key or provider secret in browser code.
- No privileged operation based only on a client-supplied role or workspace ID.
- No cross-tenant data access.
- No globally unscoped operational query after tenancy migration.
- No money arithmetic using floating-point dollars. Store integer cents.
- No destructive hard deletion of records referenced by orders, payments, billing, or audit history.
- No POS checkout dependency on marketing, CRM, AWS messaging, or nonessential integrations being online.
- No marketing send without workspace ownership, consent, suppression, and sender-identity checks.
- No silent fallback from one workspace's phone number, payment processor, or hardware to another workspace's configuration.
- No new Wayne's-specific constant when the value belongs in workspace/location configuration.
- No future client gets a cloned repo as the normal onboarding model.
- No new prospect/client workspace should be created without explicit authorization. Wayne's Pizza is the only tenant that must be seeded during this conversion.

---

# 1. PRODUCT VISION

Hanafy Media is evolving from a marketing-only service into a company that can provide integrated business software, operational tools, CRM, messaging, marketing automation, online ordering, POS functionality, analytics, and hardware/payment integrations.

The platform must support the following mental model:

```text
HANAFY MEDIA
│
├── HANAfy SITE ADMIN
│   └── Manages hanafymedia.com itself
│
└── HANAfy PLATFORM
    │
    ├── PLATFORM ADMIN
    │   └── Hanafy internal operations across all software customers
    │
    └── BUSINESS WORKSPACES
        ├── Wayne's Pizza  ← first real tenant/workspace
        └── Future tenant ← same core software, separate data/config
```

The central rule is:

> Build a feature once for the Hanafy Platform, then enable and configure it for a workspace.

The system must not become:

```text
waynes-pos
future-client-a-pos
future-client-b-pos
future-client-c-pos
```

It must become:

```text
hanafy-platform
   ├── workspace: waynes-pizza
   ├── workspace: future-client-a
   └── workspace: future-client-b
```

Each workspace receives its own data, settings, modules, integrations, phone numbers, payment connections, hardware, users, and branding while using the same application code.

---

# 2. DEFINITIONS AND SYSTEM BOUNDARIES

## 2.1 Site Admin

The **Hanafy Site Admin** manages Hanafy Media's public marketing website only.

Examples:

- Public service pages.
- Portfolio/work pages.
- Hanafy website text/images.
- Contact form/lead viewing.
- SEO/content settings.
- Public Hanafy site configuration.

Site Admin is not the place to manage restaurant payment processors, AWS numbers, hardware, POS devices, tenant billing, or customer data.

## 2.2 Platform Admin

The **Hanafy Platform Admin** is Hanafy's internal software operations console.

It manages:

- Workspaces/businesses.
- Locations.
- Enabled software services/modules.
- Workspace users/access.
- Messaging connections and phone numbers.
- Payment-provider connections.
- Hardware/devices.
- Equipment ownership and balances.
- Hanafy billing/plans.
- Integration health.
- CRM/messaging usage.
- System health and failures.
- Audit logs.
- Provisioning/onboarding.

This area is for Hanafy internal authorized users, not ordinary restaurant staff.

## 2.3 Workspace

A **workspace** represents one business organization using Hanafy software.

Wayne's Pizza becomes workspace #1.

A workspace owns or scopes:

- Locations.
- Customers/contacts.
- Orders.
- Menu data.
- Employees/workspace users.
- Marketing campaigns.
- Automations.
- Segments.
- Messaging connections.
- Payment connections.
- Hardware.
- Reporting.
- Branding and settings.
- Service/module entitlements.

## 2.4 Location

A workspace may eventually have one or more physical locations.

Wayne's begins with one location.

Operational entities such as orders, registers, caller-ID hardware, printers, terminals, kitchen stations, and business hours should be location-aware.

Customer identity should normally be workspace-level so a returning customer can be recognized across locations if multi-location support is enabled later.

## 2.5 Platform services/modules

A workspace does not automatically receive every Hanafy feature.

Potential service codes:

```text
pos
online_ordering
crm
sms
email
automations
customer_segments
caller_id
analytics
delivery
staff_management
website_storefront
hardware_management
```

The service system controls both UI visibility and server/API authorization.

---

# 3. TARGET HIGH-LEVEL ARCHITECTURE

```text
                              HANAFY MEDIA
                                   │
                 ┌─────────────────┴─────────────────┐
                 │                                   │
          PUBLIC MARKETING SITE                HANAFY PLATFORM
          hanafymedia.com                     app.hanafymedia.com
                 │                                   │
           SITE ADMIN                       PLATFORM ADMIN
                                                     │
                                      ┌──────────────┴──────────────┐
                                      │                             │
                              WORKSPACE SHELL                PLATFORM SERVICES
                                      │                             │
                              Wayne's Pizza               Auth / Billing / Health
                                      │
        ┌───────────────┬─────────────┼───────────────┬───────────────┐
        │               │             │               │               │
       POS             CRM        MARKETING        ANALYTICS      OPERATIONS
        │               │             │               │               │
     Orders         Customers      Campaigns        Reports        Caller ID
     Menu           Segments       Automations      Metrics        Devices
     Kitchen        Consent        SMS/Email        Exports        Staff
     Delivery       History        Templates                       Integrations
        │
        └───────────────────────────────────────────────────────────────┐
                                                                        │
                                                             PROVIDER ADAPTERS
                                                                        │
                                ┌─────────────────┬─────────────────────┼──────────────┐
                                │                 │                     │              │
                             Payments          Messaging             Email         Hardware
                         Square/Worldpay/etc       AWS               provider      printers/caller ID
```

## 3.1 Preferred deployment split

Preferred long-term separation:

- `hanafymedia.com` — public Hanafy marketing website.
- `hanafymedia.com/admin/site` — Site Admin.
- `app.hanafymedia.com` — authenticated Hanafy Platform.
- `app.hanafymedia.com/platform` — Hanafy Platform Admin.
- `app.hanafymedia.com/w/[workspaceSlug]` — client workspace.
- Custom client domains — tenant storefront/online-ordering routes resolved from host/domain configuration.

If current repository structure makes `/admin/platform` inside the existing Hanafy app safer during migration, that is acceptable initially. Do not make a risky repository/domain migration merely to achieve the preferred URL structure. Logical boundaries matter more than the exact hostname in early phases.

## 3.2 Repository strategy

Do not blindly rewrite repositories into a monorepo.

First audit the existing projects.

Preferred end-state if practical:

```text
apps/
  marketing-site/
  platform/
  worker/                  # optional background jobs if separated

packages/
  db/
  auth/
  tenancy/
  ui/
  pos-core/
  crm-core/
  automation-core/
  reporting/
  integrations/
    payments/
    messaging/
    email/
    hardware/
```

However, if existing applications are stable as separate repositories, migration may preserve them temporarily while sharing the same Supabase project and common contracts. Architecture quality is more important than forcing a monorepo immediately.

---

# 4. TECHNICAL BASELINE

Continue using the existing stack unless the repository audit identifies a strong reason not to:

- Next.js App Router.
- TypeScript.
- Tailwind CSS.
- Reusable accessible component library.
- Supabase Postgres.
- Supabase Auth.
- Supabase Storage.
- Supabase Realtime where operationally useful.
- Vercel for web deployment where appropriate.
- Runtime validation such as Zod.
- SQL migrations committed to source control.
- Structured logging and error monitoring.

## 4.1 Same Supabase project

The target is one shared Hanafy Supabase project for the platform, with strong workspace isolation through schema design, server authorization, and Row Level Security.

Do not create one Supabase project per business as the normal model.

Exceptions should require a deliberate future decision for contractual, regulatory, scale, or isolation reasons.

---

# 5. TENANCY MODEL — MOST IMPORTANT PLATFORM CHANGE

Every tenant-owned entity must be scoped to a workspace.

Operational records that belong to a physical store should also be scoped to a location.

## 5.1 Core tables

### `workspaces`

Recommended fields:

```text
id uuid primary key
slug text unique
name text
legal_name text nullable
status text                  # provisioning | active | suspended | archived
industry text nullable
currency_code text default 'USD'
default_timezone text
default_locale text nullable
primary_owner_name text nullable
primary_owner_email text nullable
primary_owner_phone text nullable
created_at timestamptz
updated_at timestamptz
suspended_at timestamptz nullable
archived_at timestamptz nullable
metadata jsonb
```

Do not use slug as the true database identity. Use UUID internally.

### `locations`

```text
id uuid primary key
workspace_id uuid not null references workspaces(id)
slug text
name text
status text
address1 text nullable
address2 text nullable
city text nullable
state text nullable
postal_code text nullable
country_code text
public_phone text nullable
public_email text nullable
timezone text
latitude numeric nullable
longitude numeric nullable
created_at timestamptz
updated_at timestamptz
```

Unique constraint:

```text
unique(workspace_id, slug)
```

### `workspace_domains`

```text
id uuid
workspace_id uuid
location_id uuid nullable
domain text unique
domain_type text              # storefront | ordering | redirect | other
is_primary boolean
verification_status text
verified_at timestamptz nullable
created_at timestamptz
```

### `workspace_members`

```text
id uuid
workspace_id uuid
auth_user_id uuid
workspace_role_id uuid
status text
created_at timestamptz
updated_at timestamptz
```

Unique:

```text
unique(workspace_id, auth_user_id)
```

### `workspace_invites`

Tracks invitations without granting access before acceptance.

### `platform_users`

Platform-level access is separate from client workspace membership.

```text
id uuid
auth_user_id uuid unique
platform_role text             # owner | platform_admin | support | billing | read_only
active boolean
created_at timestamptz
updated_at timestamptz
```

Do not make every workspace owner a platform admin.

---

# 6. WORKSPACE CONTEXT RESOLUTION

Every authenticated platform request must resolve a trusted workspace context.

Never accept a workspace ID from a browser and then trust it without authorization.

Recommended server flow:

```text
Request
  ↓
Authenticated Supabase user
  ↓
Resolve workspace slug/route/domain
  ↓
Load workspace UUID
  ↓
Confirm membership OR authorized platform-admin access
  ↓
Confirm requested service/module is enabled when applicable
  ↓
Execute workspace-scoped query/mutation
```

Create a reusable server helper conceptually similar to:

```ts
requireWorkspaceContext({
  workspaceSlug,
  requiredPermission,
  requiredService
})
```

Returned context should include:

```ts
{
  workspaceId,
  workspace,
  locationId?,
  userId,
  membership?,
  platformAccess?,
  permissions,
  enabledServices
}
```

Do not duplicate workspace authorization logic independently in every route.

---

# 7. ROW LEVEL SECURITY AND CROSS-TENANT SAFETY

Multi-tenancy is not complete until RLS and authorization tests prove data isolation.

## 7.1 Required principles

1. RLS enabled on every private tenant table.
2. Workspace members can only read/write rows for workspaces they are authorized to access.
3. Location restrictions can be added when a role is restricted to specific locations.
4. Platform admins receive explicit elevated access through controlled server paths and/or carefully designed policies.
5. Service-role access is server/worker only.
6. No client query should be able to change `workspace_id` to access another business.
7. Insert policies must verify the user belongs to the target workspace.
8. Update policies must prevent moving an existing row from workspace A to workspace B.
9. Unique indexes must usually include `workspace_id` unless a value is intentionally global.
10. Every foreign key chain must remain within the same workspace where applicable.

## 7.2 RLS helper functions

Create audited database helper functions where useful, for example:

```text
is_platform_admin()
is_workspace_member(workspace_id)
has_workspace_permission(workspace_id, permission_code)
```

These functions must use authenticated server/database identity, not user-supplied claims.

## 7.3 Mandatory cross-tenant tests

Create at least two test workspaces in automated tests only:

```text
Tenant A
Tenant B
```

Verify a Tenant A user cannot:

- Select Tenant B customers.
- Select Tenant B orders.
- Select Tenant B messaging jobs.
- Select Tenant B campaigns.
- Select Tenant B hardware.
- Select Tenant B payment connection metadata.
- Select Tenant B staff.
- Update Tenant B records.
- Insert records using Tenant B `workspace_id`.
- Subscribe to Tenant B realtime data.
- Guess Tenant B object IDs and access detail routes.

This test suite is a launch blocker.

---

# 8. AUTHENTICATION, ROLES, AND PERMISSIONS

Separate **platform roles** from **workspace roles**.

## 8.1 Platform roles

Initial examples:

```text
platform_owner
platform_admin
platform_support
platform_billing
platform_read_only
```

## 8.2 Workspace roles

Initial examples:

```text
owner
manager
cashier
kitchen
driver
marketing
read_only
```

Workspace roles should map to explicit permissions instead of relying only on role names.

Example permission codes:

```text
orders.read
orders.create
orders.update
orders.cancel
payments.initiate
payments.refund
payments.view
menu.read
menu.manage
customers.read
customers.manage
marketing.read
marketing.manage
campaigns.send
automations.manage
hardware.read
hardware.manage
integrations.read
integrations.manage
staff.read
staff.manage
reports.read
settings.manage
```

## 8.3 POS PIN switching

Preserve the existing fast restaurant workflow:

- Register/device is authorized.
- Staff switches using an individual PIN or equivalent fast login.
- Sensitive operations are attributed to the acting staff member.
- One shared owner credential must not be used by the whole restaurant.

## 8.4 Platform support access

Do not implement invisible impersonation.

If Hanafy staff needs to enter a client workspace for support, use an explicit audited support-access mode such as:

```text
Viewing Wayne's Pizza as Hanafy Platform Admin
```

Log:

- Hanafy actor.
- Workspace.
- Start/end time.
- Actions performed.
- Reason/ticket reference where useful.

---

# 9. SERVICE CATALOG AND MODULE ENTITLEMENTS

A workspace may purchase/use only part of the platform.

## 9.1 `service_catalog`

```text
id uuid
code text unique
name text
description text
active boolean
created_at timestamptz
```

Seed initial codes:

```text
pos
online_ordering
crm
sms
email
automations
customer_segments
caller_id
analytics
delivery
staff_management
website_storefront
hardware_management
```

## 9.2 `workspace_services`

```text
id uuid
workspace_id uuid
service_id uuid
status text                    # enabled | disabled | trial | suspended
source text                    # plan | manual | custom_contract
starts_at timestamptz nullable
ends_at timestamptz nullable
configuration jsonb
created_at timestamptz
updated_at timestamptz
```

Unique:

```text
unique(workspace_id, service_id)
```

## 9.3 Feature gating rules

Disabling a module must do more than hide navigation.

Example: if `sms` is disabled:

- SMS navigation hidden.
- SMS send routes reject requests.
- Automations cannot execute SMS actions.
- Scheduled SMS jobs are paused/rejected according to defined policy.
- Historical SMS records remain readable to authorized users if desired.

The server is authoritative for service entitlement.

---

# 10. SITE ADMIN — HANAFY MARKETING WEBSITE ONLY

Logical route:

```text
/admin/site
```

or equivalent existing admin route.

Recommended sections:

```text
Dashboard
Pages
Services
Work / Portfolio
Leads / Contact Forms
SEO
Media
Site Settings
```

Do not place client POS or tenant operational tools in this section.

Site Admin permissions should be independent from restaurant workspace roles.

---

# 11. PLATFORM ADMIN — HANAFY INTERNAL SOFTWARE COMMAND CENTER

Preferred route:

```text
app.hanafymedia.com/platform
```

Acceptable migration route:

```text
/admin/platform
```

## 11.1 Platform dashboard

Show at minimum:

- Active workspaces.
- Provisioning workspaces.
- Suspended workspaces.
- Total platform contacts/customers, clearly labeled as aggregate.
- Messaging usage by workspace.
- Messaging connection problems.
- Failed automation jobs.
- Payment connector issues.
- Offline/unhealthy hardware where health data exists.
- Open billing balances.
- Equipment balances.
- Recent platform audit events.
- Recent high-severity errors.

Do not expose sensitive customer content unnecessarily in the global dashboard.

## 11.2 Businesses/workspaces list

Columns/filter concepts:

- Business name.
- Workspace status.
- Primary location.
- Services enabled.
- Owner/contact.
- Messaging status.
- Payment provider status.
- Hardware status summary.
- Hanafy billing status.
- Created date.

## 11.3 Workspace detail inside Platform Admin

Tabs:

```text
Overview
Services
Users
Messaging
Payments
Hardware
Integrations
Billing
Equipment
Usage
Health
Audit
```

### Overview

Show:

- Business name/status.
- Workspace ID and slug.
- Locations.
- Enabled services.
- Primary owner.
- Customer/contact count.
- Order count if POS enabled.
- Current messaging origination identity.
- Payment provider connection summary.
- Device count.
- Outstanding Hanafy billing balance.
- Equipment balance.

### Services

Allow authorized Hanafy staff to:

- Enable/disable services.
- Mark custom contract services.
- Add start/end dates.
- See why a module is enabled.
- Prevent accidental removal when dependent features exist.

### Messaging

Show:

- Provider.
- Workspace phone number/origination identity.
- Sandbox/production status where relevant.
- Registration/verification status.
- Message usage.
- Recent failures.
- Opt-out/suppression count.
- Connection health.

### Payments

Show **connection metadata only**, not raw card data:

- Provider name.
- Merchant/account reference.
- Environment.
- Connection status.
- Capabilities.
- Locations.
- Terminals.
- Last successful transaction timestamp.
- Recent integration failures.

### Hardware

Show:

- Devices by location.
- Type/vendor/model.
- Ownership.
- Connection mode.
- Last seen/health.
- Assigned service.
- IP/network metadata where appropriate.
- Outstanding equipment balance if Hanafy supplied it.

### Billing

This is Hanafy's billing relationship with the client, not restaurant customer payments.

Show:

- Plan/custom agreement.
- Monthly recurring amount.
- Add-ons.
- Invoices.
- Paid/unpaid status.
- Balance.
- Notes.

### Equipment

Show:

- Asset.
- Purchase/retail price.
- Who owns it.
- Amount charged.
- Amount paid.
- Remaining balance.
- Payment schedule if used.
- Serial/model.
- Assigned location.

---

# 12. BUSINESS WORKSPACE UX

Preferred route family:

```text
/app or app.hanafymedia.com/w/[workspaceSlug]
```

Wayne's Pizza becomes the first production workspace.

Workspace navigation should be module-aware.

Recommended structure:

```text
Overview

POS
  New Order
  Phone
  Orders
  Kitchen
  Delivery
  Register / Payments

Customers
  Customer List
  Customer Detail
  Segments

Marketing
  Campaigns
  SMS
  Email
  Automations
  Templates
  Message History

Analytics
  Sales
  Customers
  Marketing
  Delivery

Employees
Devices
Integrations
Settings
```

If a service is disabled, related navigation disappears and related server routes remain blocked.

## 12.1 Workspace switcher

A user who belongs to multiple workspaces may switch between them.

Never combine two businesses' operational data in a normal workspace screen.

## 12.2 Wayne's branding

Wayne's workspace should load Wayne's name, logo, colors, location details, menu, and hardware from configuration/database records rather than hard-coded React components.

---

# 13. PUBLIC STOREFRONT AND CUSTOM DOMAIN RESOLUTION

The same platform should eventually serve tenant-specific public storefronts/online ordering.

Host resolution flow:

```text
Incoming host
  ↓
workspace_domains lookup
  ↓
Resolve workspace + location
  ↓
Load branding/business settings/menu
  ↓
Render tenant storefront
```

Rules:

- Unknown domain must fail safely.
- Never default an unknown custom domain to Wayne's.
- Canonical domain is stored in configuration.
- SEO metadata must be tenant-specific.
- Name/address/phone should come from canonical location settings.
- Public cache keys must include tenant/domain context to avoid cross-tenant content leakage.

---

# 14. BUSINESS SETTINGS AND LOCATION SETTINGS

Split workspace-wide settings from location-specific settings.

## 14.1 Workspace settings

Examples:

- Business display name.
- Legal name.
- Brand logo/assets.
- Brand colors/theme.
- Business description/story.
- Default currency.
- Default timezone.
- Support/contact details.
- Social links.
- Feature defaults.

## 14.2 Location settings

Examples:

- Address.
- Public phone.
- Hours.
- Holiday closures.
- Ordering open/closed.
- Pickup enabled.
- Delivery enabled.
- Delivery rules.
- Prep times.
- Taxes.
- Tips.
- Cash acceptance.
- Receipt header/footer.
- Caller-ID line configuration.
- Printer routing.
- Payment terminal assignments.

Common operational changes must not require a code deployment.

---

# 15. CORE CUSTOMER / CRM IDENTITY MODEL

Use one canonical workspace-scoped customer/contact identity rather than maintaining separate unrelated POS customers and CRM contacts long-term.

For compatibility, the physical table may remain named `customers`.

A marketing-only contact may exist in `customers` even if the person has never placed an order.

## 15.1 `customers`

Recommended tenant-aware fields:

```text
id uuid
workspace_id uuid not null
first_name text nullable
last_name text nullable
email_normalized text nullable
first_order_at timestamptz nullable
last_order_at timestamptz nullable
order_count integer default 0
lifetime_spend_cents bigint default 0
average_order_value_cents bigint default 0
sms_marketing_opt_in boolean
email_marketing_opt_in boolean
status text
notes text nullable
created_at timestamptz
updated_at timestamptz
```

Indexes must begin with `workspace_id` for common tenant queries.

## 15.2 Multiple phone numbers

Use a normalized child table instead of forcing one phone field forever.

### `customer_phones`

```text
id uuid
workspace_id uuid
customer_id uuid
phone_normalized text
phone_display text nullable
label text nullable
is_primary boolean
verified_at timestamptz nullable
created_at timestamptz
```

Do not assume a phone is globally unique across every workspace.

Do not even assume one phone can never match multiple customers inside a workspace; shared household/business numbers may exist. Customer lookup must support a disambiguation screen when needed.

## 15.3 Addresses

### `customer_addresses`

```text
id uuid
workspace_id uuid
customer_id uuid
label text nullable
address1 text
address2 text nullable
city text
state text
postal_code text
country_code text
latitude numeric nullable
longitude numeric nullable
delivery_instructions text nullable
is_default boolean
created_at timestamptz
updated_at timestamptz
```

Address is not the customer primary key.

## 15.4 CRM extensions

Add reusable CRM tables:

```text
customer_tags
customer_tag_assignments
customer_custom_field_definitions
customer_custom_field_values
customer_sources
customer_notes
marketing_consents
suppression_entries
```

All must include or inherit workspace scope.

---

# 16. EXISTING WAYNE'S POS DATA MODEL — MULTI-TENANT CONVERSION

Preserve the working Wayne's domain model but add workspace/location ownership.

Tables such as the following must become tenant-aware:

```text
customers
customer_phones
customer_addresses
marketing_consents
menu_categories
menu_items
menu_item_variants
modifier_groups
modifier_choices
menu_item_modifier_groups
orders
order_items
order_item_modifiers
order_events
payments
refunds
delivery_assignments
customer_segments
customer_segment_memberships
promo_codes
print_jobs
registers
shifts
cash_movements
caller_events
hardware_devices
```

## 16.1 Required scope

- `workspace_id` on all tenant-owned records.
- `location_id` on location-operational records such as orders, registers, hardware, caller events, payment terminals, kitchen stations, and shifts.
- Customers remain workspace-level by default.
- Menu may start workspace-level but must be architected to support location availability/overrides.

## 16.2 Order integrity

Preserve existing requirements:

- One canonical order model for online, POS, walk-in, and phone orders.
- Immutable historical snapshots for item names/prices/customer contact/address used at order time.
- Explicit order state machine.
- Separate payment state.
- Integer-cent totals.
- Idempotent creation.
- Audit/order events.
- No hard deletion of historical order dependencies.

## 16.3 Scoped order number uniqueness

Do not require one globally human-visible order sequence for the entire Hanafy platform.

Use a workspace/location-aware numbering strategy.

Internal UUID remains globally unique.

---

# 17. CRM, CAMPAIGNS, AND MARKETING

The existing Hanafy Campaign Manager remains. Do not remove it.

The platform continues to have two marketing lanes:

## 17.1 Lane A — Campaign Manager

Manual one-time/broadcast sends.

Flow:

```text
Select workspace
  ↓
New campaign
  ↓
Choose channel
  ↓
Choose audience/segment
  ↓
Compose/template
  ↓
Preview + test
  ↓
Consent/suppression validation
  ↓
Schedule/send
  ↓
Delivery/results
```

Every campaign record must contain `workspace_id`.

Audience queries must never cross workspaces.

## 17.2 Lane B — Automation Engine

Event/time-driven workflows.

Minimum builder:

```text
Trigger
Conditions
Timing
Actions
```

Examples:

- Customer enters inactive segment.
- Order completed.
- New customer created.
- Birthday/time trigger later.

Actions:

- Send SMS.
- Send email.
- Add/remove tag.
- Update marketing field.
- Internal notification later if useful.

## 17.3 Automation scoping

Every automation must include:

```text
workspace_id
status
version
trigger definition
condition definition
timing definition
actions
frequency/cooldown rules
```

The worker must re-verify workspace ownership before every action.

A job created for workspace A can never resolve workspace B's sender number, template, customer, or integration.

---

# 18. DOMAIN EVENT / OUTBOX ARCHITECTURE

Keep the reliability benefits of the existing Wayne's-to-CRM outbox design even as the platform becomes more integrated.

The POS must not synchronously depend on marketing processing.

## 18.1 Target event envelope

```json
{
  "event_id": "uuid",
  "workspace_id": "uuid",
  "location_id": "uuid-or-null",
  "event_type": "customer.segment.entered",
  "occurred_at": "2026-09-28T13:00:00Z",
  "source_module": "pos",
  "version": 1,
  "subject_type": "customer",
  "subject_id": "uuid",
  "data": {}
}
```

## 18.2 Event types

At minimum preserve/support:

```text
order.created
order.paid
order.completed
order.cancelled
customer.created
customer.updated
customer.metrics.updated
customer.consent.changed
customer.segment.entered
customer.segment.exited
delivery.completed
customer.merged
promo.redeemed
```

## 18.3 Shared-platform migration

If POS and CRM are now operating in the same database/application boundary, do not maintain duplicate customer copies simply because the old design used an external CRM sync.

Preferred target:

```text
Operational transaction
  ↓ same DB transaction
Authoritative record change
  + domain event/outbox row
  ↓
Asynchronous worker
  ↓
Automation/campaign/messaging systems
```

If modules remain in separate deployed applications temporarily, preserve the signed HMAC delivery adapter until consolidation is complete.

## 18.4 Idempotency

- `event_id` unique.
- Duplicate event cannot create a second automation run.
- Retried action cannot duplicate a successful message.
- Provider webhook events deduped.
- Replay tools must be audited.

---

# 19. AWS MESSAGING — WORKSPACE-SCOPED SENDER IDENTITY

The current Hanafy messaging infrastructure should become workspace-aware rather than Wayne's-specific.

Each business should normally have its own configured origination identity/phone number.

## 19.1 `messaging_connections`

```text
id uuid
workspace_id uuid
provider text                    # aws
status text                      # provisioning | sandbox | active | suspended | error
aws_region text nullable
provider_account_ref text nullable
registration_status text nullable
production_access_status text nullable
created_at timestamptz
updated_at timestamptz
```

Secrets must not be exposed to the client.

## 19.2 `messaging_origination_identities`

```text
id uuid
workspace_id uuid
location_id uuid nullable
messaging_connection_id uuid
channel text                     # sms
phone_number text nullable
provider_identity_arn text nullable
identity_type text nullable
status text
is_default boolean
created_at timestamptz
```

## 19.3 Send resolution

Every send must resolve:

```text
workspace
  ↓
workspace messaging connection
  ↓
default/selected origination identity
  ↓
recipient belonging to same workspace
  ↓
consent + suppression checks
  ↓
provider job
```

If a workspace does not have an active number, fail visibly.

Never fall back to Wayne's number or another workspace's number.

## 19.4 Message jobs

`message_jobs` should include:

```text
workspace_id
customer_id nullable
campaign_id nullable
automation_run_id nullable
channel
message_type              # marketing | transactional
origin_identity_id
recipient
status
provider_message_id
provider_status
cost metadata when available
created_at
sent_at
delivered_at
failed_at
```

## 19.5 Consent

Ordering/contact information is not automatic marketing permission.

Maintain auditable consent events and suppressions.

STOP/unsubscribe must override marketing campaigns and automations.

Transactional and marketing messages remain distinct.

---

# 20. PAYMENT ARCHITECTURE — CONNECTORS, NOT HANAFY PROCESSING

This requirement is explicit:

> Hanafy is not intended to become the payment processor, merchant of record, settlement account, or holder of client funds.

Hanafy software connects a workspace to the payment provider/merchant account that the business chooses.

Examples may include Square, Worldpay, or another supported provider, but no provider should be hard-coded as the permanent platform assumption.

## 20.1 Payment flow

```text
Hanafy POS / Online Checkout
  ↓
Workspace Payment Provider Adapter
  ↓
External payment processor / terminal
  ↓
Business merchant account
  ↓
Business bank settlement
```

Hanafy stores operational transaction results needed by the POS, not raw card credentials.

## 20.2 `payment_connections`

```text
id uuid
workspace_id uuid
location_id uuid nullable
provider text
connection_mode text             # api | terminal_api | hosted_checkout | manual_external
status text
merchant_reference text nullable
environment text                 # sandbox | production
capabilities jsonb
public_configuration jsonb
secret_reference text nullable
created_at timestamptz
updated_at timestamptz
```

Do not store reusable provider secrets in browser-readable JSON.

## 20.3 `payment_terminals`

```text
id uuid
workspace_id uuid
location_id uuid
payment_connection_id uuid
hardware_device_id uuid nullable
provider_terminal_id text nullable
name text
status text
created_at timestamptz
updated_at timestamptz
```

## 20.4 Provider interface

Conceptually:

```ts
interface PaymentProviderAdapter {
  getCapabilities(): Promise<PaymentCapabilities>;
  createOnlinePayment(request: OnlinePaymentRequest): Promise<PaymentInitiation>;
  beginCardPresentPayment(request: CardPresentPaymentRequest): Promise<PaymentInitiation>;
  getPaymentStatus(providerPaymentId: string): Promise<PaymentStatusResult>;
  cancelOrVoidPayment(request: VoidRequest): Promise<VoidResult>;
  refundPayment(request: RefundRequest): Promise<RefundResult>;
  handleWebhook(input: ProviderWebhookInput): Promise<ProviderWebhookResult>;
}
```

The order UI must not contain Square- or Worldpay-specific business logic.

## 20.5 Provider implementations

Initial architecture may include:

```text
PaymentProviderAdapter
├── ManualExternalTerminalProvider
├── SquareProvider             # only when credentials/docs/hardware are approved
├── WorldpayProvider           # only when integration path is confirmed
└── FutureProvider
```

Do not fake provider support. A provider can appear in the platform catalog as `not configured` or `planned` but must not show `connected` until a real integration exists and passes tests.

## 20.6 Card-data rules

Hanafy must not store:

- Full card number.
- CVV.
- Magnetic-track data.
- PIN data.

Where the provider returns safe metadata, Hanafy may store fields such as:

- Provider transaction ID.
- Amount.
- Status.
- Payment method type.
- Card brand.
- Last four digits.
- Terminal ID.
- Authorization/capture timestamps.

The exact allowed fields should follow provider documentation and the chosen integration.

## 20.7 Failure safety

Handle:

- Browser closes after processor success.
- Duplicate processor webhook.
- Webhook arrives before browser callback.
- Terminal offline.
- Payment succeeds but application response fails.
- Refund retry.
- Processor timeout.

Use idempotency and reconciliation.

---

# 21. HARDWARE AND DEVICE MANAGEMENT

Hardware becomes a first-class workspace/location resource in Platform Admin.

## 21.1 `hardware_devices`

Recommended fields:

```text
id uuid
workspace_id uuid
location_id uuid
device_type text
vendor text nullable
model text nullable
serial_number text nullable
asset_tag text nullable
name text
status text
ownership_type text             # customer_owned | hanafy_owned | financed | leased
connection_type text nullable   # ethernet | wifi | usb | serial | other
ip_address inet nullable
mac_address macaddr nullable
protocol text nullable
port integer nullable
last_seen_at timestamptz nullable
health_status text nullable
configuration jsonb
created_at timestamptz
updated_at timestamptz
```

Do not place secrets in `configuration` if that JSON is browser-readable.

## 21.2 Device types

Examples:

```text
pos_tablet
kitchen_display
caller_id
receipt_printer
kitchen_printer
cash_drawer
payment_terminal
router
access_point
ups
other
```

## 21.3 Hardware adapter rule

Preserve the existing Wayne's rule:

> Operational UI must not directly contain vendor-specific hardware code.

Continue using provider interfaces for:

- Caller ID.
- Printers.
- Cash drawer.
- Payment terminals.

## 21.4 Health

Where possible record:

- Connected/disconnected.
- Last seen.
- Last successful action.
- Last error.
- Error count.

Do not make unsupported devices appear live merely because they have a database row.

---

# 22. WAYNE'S CALLER ID AND LOCAL HARDWARE MIGRATION

Wayne's existing phone workflow remains an important reference implementation.

For Wayne's, preserve the existing hardware-abstraction architecture and two-line caller workflow.

Known migration concepts from the existing implementation/spec:

- Caller-ID data is handled through a `CallerIdProvider` abstraction.
- Website development can use a simulated provider.
- Future native Android integration receives local network caller events and feeds the same UI event contract.
- Line 1 and Line 2 remain separate.
- Incoming calls must not force-navigate staff away from an active order.
- Multiple terminals require claim/lock behavior.
- Caller events link to resulting phone orders.

Tenantize the data model:

### `phone_lines`

```text
id uuid
workspace_id uuid
location_id uuid
caller_id_device_id uuid nullable
line_number integer
label text
public_phone_number text nullable
active boolean
created_at timestamptz
```

Unique:

```text
unique(location_id, line_number)
```

### `caller_events`

Add:

```text
workspace_id uuid
location_id uuid
phone_line_id uuid nullable
```

Retain existing fields such as caller number, caller name, matched customer, claimed user/device, linked order, received time, and raw provider metadata where safe.

## 22.1 Local-first event behavior

For future native hardware:

```text
Local caller hardware
  ↓
Native provider
  ↓
Hardware event bus
  ↓
Phone UI immediately
  ↓
Cloud lookup/logging/enrichment
```

Do not require a cloud round-trip before the employee can see that a call arrived.

---

# 23. BILLING, PLANS, AND EQUIPMENT BALANCES

This section manages money owed **to Hanafy Media for Hanafy services/equipment**. It is separate from restaurant customer card processing.

## 23.1 Plans

### `platform_plans`

```text
id uuid
name text
code text unique
description text
active boolean
base_monthly_price_cents bigint nullable
created_at timestamptz
updated_at timestamptz
```

### `plan_services`

Maps default services to plans.

## 23.2 Workspace subscription

### `workspace_subscriptions`

```text
id uuid
workspace_id uuid
plan_id uuid nullable
status text
monthly_price_cents bigint
billing_interval text
start_date date
end_date date nullable
custom_terms text nullable
created_at timestamptz
updated_at timestamptz
```

Do not force all clients into standardized plans; custom contract pricing must be supported.

## 23.3 Hanafy invoices

Use clearly named platform billing tables so they are not confused with restaurant POS payments.

```text
platform_invoices
platform_invoice_items
platform_invoice_payments
```

## 23.4 Equipment assets and balances

### `equipment_assets`

May extend/link `hardware_devices`.

Fields:

```text
id uuid
workspace_id uuid
hardware_device_id uuid nullable
name text
vendor text nullable
model text nullable
serial_number text nullable
ownership_type text
hanafy_cost_cents bigint nullable
customer_price_cents bigint nullable
amount_paid_cents bigint default 0
balance_due_cents bigint generated/derived or computed
purchased_at date nullable
assigned_at date nullable
notes text nullable
```

Balance should be calculated from authoritative charges/payments rather than manually typed in multiple places.

## 23.5 Billing v1 can be manual

Do not add Stripe or automatic recurring billing unless explicitly requested.

The first version may simply track:

- What the customer owes.
- Due dates.
- Payment status.
- Manual recorded payments.
- Equipment balances.

---

# 24. INTEGRATION REGISTRY

Create one consistent place to see every external connection.

### `integration_connections`

```text
id uuid
workspace_id uuid
location_id uuid nullable
integration_type text           # payment | messaging | email | maps | hardware_bridge | other
provider text
status text
name text
public_configuration jsonb
secret_reference text nullable
last_success_at timestamptz nullable
last_error_at timestamptz nullable
last_error_summary text nullable
created_at timestamptz
updated_at timestamptz
```

Provider-specific tables may extend this record when structured fields are needed.

Do not create a giant unvalidated JSON bucket for every integration. Use generic metadata plus typed provider-specific configuration where important.

---

# 25. ADD BUSINESS / WORKSPACE PROVISIONING FLOW

Platform Admin needs a controlled `Add Business` workflow.

## 25.1 Step 1 — Business details

Capture:

- Display name.
- Legal name if known.
- Workspace slug.
- Primary owner/contact.
- Industry/type.
- Timezone.
- Currency.

Create workspace in `provisioning` state.

## 25.2 Step 2 — First location

Capture:

- Location name.
- Address.
- Phone.
- Email.
- Hours.
- Timezone if different.

## 25.3 Step 3 — Services

Select which modules are being provided.

Examples:

```text
[ ] POS
[ ] Online Ordering
[ ] CRM
[ ] SMS
[ ] Email
[ ] Automations
[ ] Caller ID
[ ] Analytics
[ ] Delivery
```

Do not mark a service enabled if required provisioning is incomplete unless the service supports an explicit `provisioning` state.

## 25.4 Step 4 — Workspace owner account

Invite/create the initial client owner user.

Do not send a usable login until access is correctly scoped.

## 25.5 Step 5 — Messaging

If purchased:

- Create/select AWS messaging connection.
- Assign/provision origination identity.
- Track registration/verification status.
- Track sandbox vs production access.
- Configure default send windows.

## 25.6 Step 6 — Payment connection

If POS/online ordering requires payment:

- Select provider.
- Select integration mode.
- Record merchant connection status.
- Connect location(s).
- Register terminal(s) if applicable.
- Test in sandbox before production.

The client/business remains the merchant account owner/recipient of settlement.

## 25.7 Step 7 — Hardware

Add devices:

- POS tablet.
- Printers.
- Caller-ID equipment.
- Cash drawer.
- Payment terminals.
- Network equipment where Hanafy needs to track it.

Record ownership and equipment balance.

## 25.8 Step 8 — Data import

Optional:

- Customers/contacts.
- Menu.
- Historical orders if trustworthy and useful.
- Marketing consents with source evidence.

Always provide preview/dedupe before committing a large import.

## 25.9 Step 9 — Validation checklist

Workspace cannot become `active` until required items for purchased services pass.

Examples:

- RLS/access validated.
- Owner login works.
- At least one location exists.
- Required business settings complete.
- Messaging identity active before SMS send.
- Payment provider tested before live card acceptance.
- Hardware tested before marking connected.

## 25.10 Step 10 — Activate

Set workspace `active` only after provisioning checklist passes.

---

# 26. WAYNE'S PIZZA AS WORKSPACE #1

Create exactly one real workspace during the initial migration:

```text
Wayne's Pizza
```

Do not create prospect/demo workspaces from prior sales conversations unless explicitly requested.

## 26.1 Wayne's migration rules

- Preserve existing Wayne's business data.
- Preserve order history.
- Preserve customer identity/history.
- Preserve menu data.
- Preserve campaign/CRM records.
- Preserve consent/suppression records.
- Preserve caller-ID workflow.
- Preserve POS/KDS/driver behavior already built.
- Preserve hardware adapter contracts.
- Preserve current AWS messaging behavior while making it workspace-configured.

## 26.2 Seed structure

Create:

```text
Workspace: Wayne's Pizza
Location: Worcester location
```

Use UUIDs. Do not hard-code logic against the literal string `waynes-pizza` beyond seed/configuration and human-friendly routing.

## 26.3 Backfill strategy

For each existing tenant-owned table:

1. Add nullable `workspace_id`.
2. Add nullable `location_id` where required.
3. Create Wayne's workspace/location rows.
4. Backfill all existing Wayne's data.
5. Validate no orphan records remain.
6. Add foreign keys.
7. Add workspace-aware indexes.
8. Update application queries/mutations.
9. Add RLS.
10. Run regression tests.
11. Only then set required columns `NOT NULL`.

Do not make columns `NOT NULL` before existing rows are safely backfilled.

---

# 27. DE-HARDCODING WAYNE'S

Audit the entire Wayne's codebase for hard-coded values including:

```text
Business name
Logo
Address
Phone
Email
Timezone
Tax rates
Hours
Delivery settings
Menu assumptions
AWS number
Payment provider
Payment terminal
Caller-ID line count
Hardware model names
Printer routing
Receipt text
Domain
Social links
Brand colors
Location IDs
```

Move values into appropriate workspace/location/integration configuration.

Do not replace one hard-coded Wayne's value with another hard-coded Hanafy default that will be wrong for future tenants.

Defaults may exist, but workspace configuration must override them.

---

# 28. REPORTING AND ANALYTICS

All tenant reporting must be workspace-scoped.

Location filter support should be available where relevant.

Initial workspace reports may include:

- Sales by date/hour.
- Orders by source.
- Orders by fulfillment.
- Orders by payment method/provider.
- Sales by category/item.
- Discounts/promos.
- Refunds.
- Top customers.
- Returning customer rate.
- Lifetime spend.
- Segment populations.
- Messaging sends/delivery/failures.
- Campaign performance.
- Automation performance.
- Delivery performance.
- Staff/shift activity.

Platform Admin aggregate metrics must clearly label that they are cross-workspace platform totals and should avoid exposing unnecessary customer PII.

All financial reports derive from authoritative order/payment/cash records, not UI-side estimates.

---

# 29. AUDIT LOGGING

Create a reusable audit system.

### `audit_logs`

Recommended fields:

```text
id uuid
workspace_id uuid nullable
location_id uuid nullable
actor_auth_user_id uuid nullable
actor_type text                 # workspace_user | platform_user | system
actor_role text nullable
action text
resource_type text
resource_id text nullable
before_data jsonb nullable
after_data jsonb nullable
reason text nullable
correlation_id text nullable
ip_address inet nullable
user_agent text nullable
created_at timestamptz
```

Do not log secrets, raw card payloads, or unnecessary sensitive data.

Audit at minimum:

- Workspace creation/suspension.
- Service enable/disable.
- Workspace role changes.
- Platform support access.
- Integration configuration changes.
- Messaging identity changes.
- Payment connection changes.
- Hardware assignment/config changes.
- Refunds/voids.
- Manual discounts/price overrides.
- Menu changes.
- Customer merges.
- Automation publish/pause.
- Failed-event replay.
- Billing/equipment balance adjustments.

---

# 30. OBSERVABILITY AND SYSTEM HEALTH

Platform Admin requires real support visibility.

Track:

- Structured server errors.
- Correlation/request IDs.
- Workspace ID on logs where safe.
- Event/outbox queue depth.
- Failed automation runs.
- Failed message jobs.
- Provider webhook failures.
- Payment reconciliation problems.
- Printer queue problems.
- Device last-seen status.
- Realtime/KDS connection status.
- Background worker health.
- Failed imports.

Do not expose secrets or full sensitive provider payloads in UI logs.

---

# 31. SECURITY REQUIREMENTS

Minimum requirements:

- Supabase RLS on every private tenant table.
- Server-side permission checks for privileged operations.
- Strong cross-tenant automated tests.
- Service-role key server-only.
- Provider secrets server-only.
- Secure secret storage/reference strategy.
- Strict input validation.
- Rate limiting for public write endpoints.
- Secure auth/session management.
- Idempotency for critical writes.
- Webhook signature verification for external providers.
- Replay-window validation when applicable.
- Database backups.
- Least-privilege access.
- Audit logs.
- No raw payment card data.
- PII only shown to roles that need it.
- No public exposure of local Caller-ID UDP listeners or private LAN hardware services.
- Tenant/domain cache isolation.
- File/storage paths scoped by workspace.

## 31.1 Storage isolation

Store tenant assets under workspace-scoped paths, e.g.:

```text
workspaces/{workspaceId}/menu/...
workspaces/{workspaceId}/branding/...
```

Storage policies must prevent one workspace from reading or overwriting another workspace's private assets.

---

# 32. RELIABILITY AND FAILURE SCENARIOS

The system must fail visibly and recoverably.

Test at minimum:

- Customer double-clicks Place Order.
- Staff double-submits POS order.
- Browser refreshes during order creation.
- Network drops after server receives the order.
- Realtime disconnect/reconnect.
- Kitchen display reconnect.
- Printer offline.
- Caller-ID provider disconnect.
- AWS messaging outage.
- Automation worker delayed.
- Payment provider outage.
- Payment success but client callback lost.
- Duplicate provider webhook.
- Out-of-order provider webhook.
- Workspace service disabled while a scheduled job exists.
- Workspace suspended.
- Platform admin edits wrong tenant accidentally — confirmation/context safeguards.
- User manually changes URL from workspace A to workspace B.
- User guesses another tenant's order/customer UUID.
- Two tenants have same customer phone number.
- Two tenants have same menu item name.
- Two tenants use different payment providers.
- Two tenants use different SMS numbers.
- One tenant's integration is broken while another tenant continues normally.
- App deploy occurs during store hours.
- Timezone/DST boundary.

A failure in one tenant's provider connection must not affect another tenant.

---

# 33. DATA IMPORT AND MIGRATION TOOLS

Build reusable imports rather than Wayne's-only scripts where practical.

Imports may support:

- Customers.
- Phone numbers.
- Emails.
- Addresses.
- Consent records.
- Menu/category/item data.
- Historical orders later.

Every import must require a `workspace_id` resolved by trusted server context.

Import flow:

```text
Upload
  ↓
Parse
  ↓
Validate
  ↓
Normalize
  ↓
Preview errors
  ↓
Preview dedupe/matches
  ↓
Confirm
  ↓
Transactional/batched import
  ↓
Import report
```

Never silently merge contacts based on weak identity alone.

---

# 34. BACKGROUND JOBS

Any delayed/retryable work should use a durable job/outbox strategy rather than browser timers.

Examples:

- Marketing messages.
- Automation delays.
- Segment reevaluation.
- Event delivery.
- Provider reconciliation.
- Imports.
- Retryable print/cloud jobs.
- Health polling where applicable.

Every job must include workspace scope.

Recommended common fields:

```text
workspace_id
job_type
status
attempts
max_attempts
run_at
locked_at
completed_at
last_error
idempotency_key
payload
```

Workers must validate workspace/service state at execution time, not only when the job was created.

---

# 35. APPLICATION FOLDER / MODULE ORGANIZATION

Adapt to existing repository. Example only:

```text
src/
  app/
    (public)/
    platform/
    w/[workspaceSlug]/
      overview/
      pos/
      orders/
      customers/
      marketing/
      analytics/
      employees/
      devices/
      integrations/
      settings/

  modules/
    tenancy/
    auth/
    services/
    pos/
    customers/
    crm/
    campaigns/
    automations/
    messaging/
    payments/
    hardware/
    reporting/
    billing/

  integrations/
    payments/
      provider.ts
      manual-external.ts
      square.ts          # only when implemented
      worldpay.ts        # only when implemented
    messaging/
      aws.ts
    hardware/
      caller-id/
      printers/
      drawer/

  lib/
    db/
    supabase/
    validation/
    logging/
    money/
    time/
```

Do not scatter workspace authorization across unrelated UI components. Centralize tenancy helpers.

---

# 36. API / SERVER ACTION DESIGN RULES

Every tenant mutation should conceptually follow:

```text
authenticate
  ↓
resolve authorized workspace
  ↓
check permission
  ↓
check service entitlement
  ↓
validate input
  ↓
execute scoped transaction
  ↓
audit if required
  ↓
return safe response
```

Never accept `workspace_id` as an unrestricted mutation field when it can be derived from route/session context.

For platform-admin actions that intentionally target a workspace, require explicit platform permission and audit the target workspace.

---

# 37. CACHE, REALTIME, AND CLIENT STATE

Multi-tenancy must apply to non-database state too.

## 37.1 Cache keys

Include workspace/location in cache keys.

Bad:

```text
menu
customers
orders-today
```

Good:

```text
workspace:{workspaceId}:location:{locationId}:menu
workspace:{workspaceId}:orders:{date}
```

## 37.2 Realtime

Realtime subscriptions must filter by workspace/location.

Do not subscribe to all orders globally and filter only in the browser.

## 37.3 Local storage

Draft/cart/local state keys must include workspace/location so switching tenants cannot load another tenant's draft.

Example:

```text
hanafy:{workspaceId}:{locationId}:pos-draft
```

---

# 38. PLATFORM BILLING VS RESTAURANT PAYMENTS — NAMING RULE

To avoid dangerous confusion, code and UI must clearly distinguish:

```text
Restaurant customer payment
```

from:

```text
Client paying Hanafy Media
```

Suggested naming:

- POS/customer transactions: `payments`, `refunds`, `payment_connections`.
- Hanafy invoices: `platform_invoices`, `platform_invoice_payments`.

Never reuse the same `payments` table for both concepts.

---

# 39. SUSPENSION / OFFBOARDING

Workspace statuses:

```text
provisioning
active
suspended
archived
```

## 39.1 Suspended

Suspension behavior must be deliberate by service.

Do not automatically destroy data.

Potential behavior:

- Client login limited or disabled.
- Marketing sends stop.
- Scheduled automations pause.
- Public site behavior follows configured policy.
- Historical/admin data retained.

Because POS shutdown can directly affect a business's ability to operate, do not create an automatic billing-triggered POS kill switch without explicit business rules and warnings.

## 39.2 Archived

Archive only after offboarding procedure.

Support export of client-owned operational data where appropriate.

Historical billing/audit records may need retention even if workspace operational access ends.

---

# 40. MIGRATION STRATEGY — DO NOT REWRITE EVERYTHING

The safest path is progressive tenantization.

## Phase 0 — Repository and database audit

Before code changes:

- Map Hanafy site admin.
- Map Hanafy CRM routes/tables.
- Map Wayne's POS routes/tables.
- Map auth/users/roles.
- Map existing migrations.
- Map all Wayne's-specific constants.
- Map AWS messaging configuration.
- Map campaign/automation code.
- Map hardware adapter code.
- Map payment abstractions.
- Identify duplicate concepts between POS and CRM.
- Produce a dependency diagram.

**Acceptance:** written audit exists and no schema/code changes were made blindly.

---

## Phase 1 — Core tenancy schema

Build:

- `workspaces`.
- `locations`.
- `workspace_members`.
- platform-user roles.
- `service_catalog`.
- `workspace_services`.
- tenancy helper functions.
- basic RLS foundations.

Create Wayne's workspace + first location.

Do not yet change normal Wayne's UX.

**Acceptance:** Wayne's workspace/location exist; test workspaces can be created in automated tests; auth helpers resolve workspace safely.

---

## Phase 2 — Backfill Wayne's operational data

Add `workspace_id` and where appropriate `location_id` to existing tenant-owned tables.

Backfill all current Wayne's rows.

Update indexes/foreign keys.

Do not set NOT NULL until validation succeeds.

**Acceptance:** zero tenant-owned legacy rows remain unassigned; old Wayne's functionality still works; data counts/totals before and after migration match.

---

## Phase 3 — RLS and server authorization hardening

Implement workspace RLS across all tenant data.

Rewrite server actions/API routes to derive authorized workspace context.

Add cross-tenant test suite.

**Acceptance:** Tenant A cannot read/write Tenant B through UI, API, direct Supabase client, guessed IDs, realtime, or storage.

This phase is a hard blocker before adding real future tenants.

---

## Phase 4 — De-hardcode Wayne's into workspace/location configuration

Move Wayne's-specific constants to settings/configuration.

Update:

- branding.
- business info.
- hours.
- domain.
- taxes.
- delivery.
- messaging identity.
- payment config.
- hardware configuration.
- caller-line configuration.
- receipt text.

**Acceptance:** changing test workspace configuration changes behavior without code edits, while Wayne's still looks/operates correctly.

---

## Phase 5 — Workspace shell and service gating

Build:

- workspace navigation.
- workspace switcher.
- module-aware navigation.
- server-side service entitlement enforcement.
- workspace overview.

**Acceptance:** disabling a service removes UI and blocks its server actions; enabling it restores authorized access.

---

## Phase 6 — Platform Admin foundation

Build:

- Platform dashboard.
- Workspaces list.
- Workspace detail.
- Services tab.
- Users tab.
- Health/audit summaries.

**Acceptance:** authorized Hanafy platform user can manage Wayne's workspace; ordinary Wayne's owner cannot access Platform Admin.

---

## Phase 7 — Tenantize Hanafy CRM and messaging

Migrate existing CRM `business` concept to workspaces.

Ensure:

- contacts/customers are workspace-scoped.
- campaigns workspace-scoped.
- templates workspace-scoped where appropriate.
- message jobs workspace-scoped.
- AWS sender identity resolves from workspace.
- suppressions/consent enforced per workspace/channel.

Preserve Campaign Manager.

**Acceptance:** test workspaces with different sender identities cannot send from each other's number; contact lists never cross.

---

## Phase 8 — Unify event/automation architecture

Preserve POS outbox reliability while reducing duplicate data if CRM and POS now share a platform database.

Build:

- workspace-aware domain events.
- automation triggers.
- durable runs/jobs.
- idempotency.
- explainable execution logs.

**Acceptance:** Wayne's segment-enter event creates exactly one matching automation run; duplicate event does not duplicate message; another test tenant's workflows never run.

---

## Phase 9 — Integration registry + payment connectors

Build:

- integration registry.
- payment connection records.
- terminal records.
- provider capability model.
- Manual External Terminal adapter.
- Platform Admin payment status screens.

Do not implement fake Square/Worldpay production connections.

**Acceptance:** Wayne's can be configured with a provider/mode without order code being provider-specific; no raw card data stored.

---

## Phase 10 — Hardware/device administration

Build:

- hardware device registry.
- location assignment.
- ownership.
- health.
- caller-ID configuration.
- printer configuration.
- payment-terminal link.
- equipment asset link.

Migrate Wayne's known hardware records.

**Acceptance:** Wayne's hardware is represented in Platform Admin; existing caller-ID/POS abstractions continue to work.

---

## Phase 11 — Hanafy billing + equipment balances

Build manual first version:

- plans.
- custom subscription.
- platform invoices.
- manual invoice payments.
- equipment assets/charges/payments.
- outstanding balances.

**Acceptance:** Platform Admin can answer: what services is Wayne's on, what is the monthly price, what invoices are unpaid, and does Wayne's owe money on Hanafy-supplied equipment?

---

## Phase 12 — Add Business provisioning flow

Build guided onboarding and activation checklist.

**Acceptance:** developer can create a temporary test workspace without writing SQL manually; workspace receives only selected modules and correct access.

Do not create real future customer workspaces without explicit authorization.

---

## Phase 13 — Multi-tenant storefront/custom domain layer

Build host/domain resolution and tenant storefront configuration.

**Acceptance:** two test domains/workspace contexts render different business data with no cache/data leakage.

---

## Phase 14 — Wayne's full regression and production hardening

Run the complete Wayne's operational suite:

- online ordering.
- POS.
- phone orders.
- caller-ID simulator/native path as available.
- customer lookup.
- kitchen.
- delivery.
- payments/manual terminal/current provider path.
- printing.
- shifts/cash.
- customer metrics.
- segments.
- campaign sending.
- automations.
- AWS messaging.
- reports.

**Acceptance:** Wayne's behavior is functionally equivalent or better after tenantization and no data is lost.

---

# 41. TEST PLAN

## 41.1 Unit tests

- Workspace context resolver.
- Permission evaluation.
- Service entitlement evaluation.
- Money calculations.
- Order totals.
- Tax calculations.
- Segment rules.
- Phone normalization.
- Payment adapter capability handling.
- Billing balance calculations.
- Event idempotency.

## 41.2 Database/RLS tests

Highest priority:

- Cross-workspace selects blocked.
- Cross-workspace inserts blocked.
- Cross-workspace updates blocked.
- Cross-workspace deletes blocked.
- Platform admin allowed only through intended policies/server paths.
- Workspace user cannot promote self to platform role.
- Workspace user cannot alter own role without permission.
- Storage isolation.

## 41.3 Integration tests

- Order transaction + domain event atomicity.
- Customer metrics update within correct workspace.
- Segment change within correct workspace.
- Message sender resolution.
- Suppression checks.
- Payment webhook reconciliation.
- Hardware assignment resolution.
- Equipment balance rollup.
- Service-disable behavior.

## 41.4 End-to-end tests

### Scenario A — Wayne's POS order

1. Wayne's staff logs in.
2. Starts order.
3. Customer lookup returns only Wayne's customers.
4. Order completes.
5. Kitchen sees order.
6. Wayne's reports update.
7. Wayne's customer metrics update.
8. Event/automation is scoped to Wayne's.

### Scenario B — cross-tenant attack

1. User belongs only to Tenant A.
2. Guess Tenant B customer URL.
3. Access denied.
4. Guess Tenant B order UUID.
5. Access denied.
6. Modify API payload to Tenant B workspace ID.
7. Access denied.
8. Subscribe to Tenant B realtime filter.
9. No unauthorized data returned.

### Scenario C — different payment providers

1. Tenant A configured with provider A.
2. Tenant B configured with provider B.
3. Tenant A payment uses provider A adapter.
4. Tenant B payment uses provider B adapter.
5. No provider credentials/config cross over.

### Scenario D — different SMS numbers

1. Tenant A has sender A.
2. Tenant B has sender B.
3. Tenant A campaign sends only through sender A.
4. Tenant B campaign sends only through sender B.
5. Missing sender causes explicit error; no fallback.

### Scenario E — service gating

1. Disable SMS for test workspace.
2. SMS navigation disappears.
3. Direct SMS API call rejected.
4. Existing history remains intact.
5. Pending scheduled jobs follow documented pause/cancel policy.

### Scenario F — Hanafy internal support

1. Platform admin enters Wayne's support context.
2. UI clearly indicates target workspace.
3. Actions are audited.
4. Wayne's ordinary staff cannot access platform console.

---

# 42. UI/UX QUALITY BAR

This is real operational software.

Requirements:

- Responsive.
- Fast on modest tablets.
- Touch-friendly POS/KDS.
- Clear workspace name/context at all times.
- Platform Admin must make target business obvious before high-risk changes.
- Clear loading/error/empty states.
- No tiny controls during restaurant rush workflows.
- Minimal distracting animation in POS/KDS.
- Confirmation for destructive/high-risk actions.
- Accessible labels and contrast.
- Workspace switcher should not cause accidental cross-business actions.
- After switching workspace, stale previous-workspace data must be cleared from client state.

---

# 43. THINGS CODEX / CLAUDE CODE MUST NOT DO

- Do not build all phases in one prompt.
- Do not create one database/project per business as the default architecture.
- Do not clone Wayne's code for future tenants.
- Do not seed prior prospects as tenants.
- Do not let workspace A read workspace B.
- Do not rely on UI hiding as authorization.
- Do not trust browser-supplied workspace IDs.
- Do not scatter payment-provider SDK calls through order components.
- Do not make Hanafy the merchant of record by accident.
- Do not store raw card data.
- Do not silently use Wayne's AWS number as a platform default.
- Do not rebuild/remove the existing Campaign Manager.
- Do not create duplicate CRM contacts if a unified customer record can safely serve both systems.
- Do not remove the outbox/event reliability boundary just because modules share a database.
- Do not make ordering depend on marketing systems being online.
- Do not hard-code Wayne's business settings.
- Do not hard-code device IPs that have not been confirmed.
- Do not invent unsupported hardware/protocol capabilities.
- Do not mark a provider/device connected without a successful real test.
- Do not change old historical order snapshots after menu/customer edits.
- Do not automatically suspend operational POS access for billing without an explicit policy.
- Do not expose platform aggregate customer PII unnecessarily.

---

# 44. DEFINITION OF DONE — HANAFY PLATFORM FOUNDATION

The platform foundation is not considered complete until:

- Wayne's is represented as a workspace, not a special-case application identity.
- Wayne's has at least one location.
- Existing Wayne's data is backfilled with workspace/location scope.
- No orphan tenant records remain.
- RLS isolation passes automated cross-tenant tests.
- Workspace routing/context is server-authorized.
- Site Admin and Platform Admin are logically separated.
- Platform Admin can manage Wayne's services, users, integrations, messaging, payments, hardware, billing, and equipment records.
- Workspace module gating works on UI and server.
- Existing Hanafy CRM businesses/contacts/messages are migrated or mapped to workspace-aware records without data loss.
- AWS sender identity resolves by workspace.
- Payment provider resolves by workspace/location through adapters.
- Hanafy does not store raw card data or receive settlement funds.
- Hardware is workspace/location-scoped.
- Wayne's caller-ID/phone workflow remains operational.
- Wayne's POS behavior is preserved.
- Existing Campaign Manager is preserved.
- Automation runs are workspace-scoped and idempotent.
- Audit logs exist for privileged platform actions.
- Billing and equipment balances are clearly separate from POS customer payments.
- A test workspace can be provisioned through the Add Business flow without source-code edits.
- Build, typecheck, lint, migrations, unit tests, integration tests, RLS tests, and E2E tests pass.

---

# 45. PROJECT PRIORITY ORDER

When engineering tradeoffs are necessary, use this priority order:

1. Never leak data between businesses.
2. Never lose or duplicate an order.
3. Correct payment/order/cash state.
4. Kitchen receives the correct ticket.
5. Staff can operate quickly during a rush.
6. Historical data remains trustworthy.
7. Customer consent/privacy remains correct.
8. Provider/integration failures are isolated and recoverable.
9. Reports reconcile.
10. Marketing automation behaves safely.
11. Platform billing/equipment records are accurate.
12. Visual polish and secondary convenience features.

---

# 46. FIRST PROMPT TO GIVE CODEX / CLAUDE CODE

Use this after placing this specification in the repository as something like:

```text
docs/HANAFY_PLATFORM_MASTER_BUILD_SHEET.md
```

Prompt:

> Read `docs/HANAFY_PLATFORM_MASTER_BUILD_SHEET.md` completely before making changes. Also locate and read the existing Wayne's POS master specification and Wayne's hardware/caller-ID specification if they exist in the repository. Treat the Hanafy Platform build sheet as the source of truth for the multi-tenant conversion and the older Wayne's documents as the source of truth for existing Wayne's operational behavior that must be preserved. Do not code yet. First perform **Phase 0 — Repository and database audit only**. Inspect the Hanafy Media marketing/site-admin code, Hanafy CRM, Wayne's POS code, Supabase schema/migrations/RLS, auth/roles, AWS messaging, payment abstractions, campaign/automation system, and hardware adapters. Identify every Wayne's-specific hard-coded assumption and every duplicate concept between the POS and CRM. Return: (1) current architecture map, (2) current database table map, (3) auth/RLS map, (4) integration map, (5) Wayne's-specific constants that must become workspace configuration, (6) migration risks, (7) proposed exact Phase 1 file/migration plan, and (8) anything in the repository that conflicts with the build sheet. Do not make schema or code changes until I approve the audit.

---

# 47. TEMPLATE PROMPT FOR EACH IMPLEMENTATION PHASE

> Read `docs/HANAFY_PLATFORM_MASTER_BUILD_SHEET.md` again and review all work from previous phases. Implement **Phase X only**. Preserve all existing Wayne's functionality. Do not introduce future-tenant data except automated test fixtures. Use migrations for all schema changes. Every tenant-owned record must follow the workspace/location rules in the build sheet. Enforce authorization server-side and with RLS; do not rely on UI hiding. Add or update unit, integration, RLS, and E2E tests appropriate to this phase. Run migrations on a development database, then run typecheck, lint, tests, and production build. When complete, stop and report: files changed, schema/migrations, data backfills, RLS changes, environment/setup steps, automated test results, manual test instructions, known limitations, and a requirement-by-requirement acceptance checklist. Do not begin the next phase until I explicitly approve it.

---

# 48. SIMPLE MENTAL MODEL FOR FUTURE DEVELOPMENT

Every feature should answer these questions:

```text
Which workspace owns this?
Which location owns this, if applicable?
Which user is allowed to do this?
Which service/module enables this?
Which provider/integration belongs to this workspace?
How does it fail without affecting other workspaces?
How is the action audited?
```

If a new feature cannot answer those questions, it is not yet designed correctly for Hanafy Platform.

The final mental model is:

```text
Hanafy Platform
     ↓
Workspace
     ↓
Location
     ↓
Enabled Services
     ↓
Business Data + Users + Integrations + Hardware
```

Wayne's Pizza is the first real workspace proving the platform, not a permanent special case in the codebase.
