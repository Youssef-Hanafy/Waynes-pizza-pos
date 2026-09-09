# Wayne's Pizza POS + Online Ordering + Customer Intelligence + Hanafy Media CRM
## Master Developer / Codex Build Sheet

**Revision:** v3 — consolidated master specification from the full Wayne's Pizza POS discussion  
**Purpose:** This document is the source of truth for building a production-ready POS and online ordering system for Wayne's Pizza, plus the event-driven integration and automation work required in the separate Hanafy Media CRM.  
**Build philosophy:** Build a reliable restaurant operating system in verified phases. Do not attempt to generate the whole product in one pass.

---

# 0. HOW CODEX / A HUMAN DEVELOPER MUST USE THIS DOCUMENT

Treat this as a real software project specification, not a loose feature list.

Before changing code:
1. Read this document completely.
2. Inspect the existing repository before deciding architecture or creating duplicate systems.
3. Identify which phase is currently authorized.
4. Build only that phase plus the minimum interfaces needed for future phases.
5. Do not silently skip requirements because they are difficult or hardware-dependent.
6. If a future requirement cannot be completed yet, create the correct interface/adapter and mark it clearly as deferred rather than hard-coding a temporary architecture that will have to be rewritten.
7. After each phase, run tests, type-check, lint/build, and give a written completion report.
8. Never claim a phase is complete unless its acceptance criteria pass.

## Required completion report after every phase
Codex/developer must report:
- What was built.
- What files were created/changed.
- What database migrations were added.
- What environment variables are required.
- What setup the owner must complete manually.
- What automated tests were added and their results.
- Exact manual test steps.
- Known limitations or deferred items.
- Whether the phase acceptance criteria passed.
- What the next phase is, without starting it unless explicitly told to.

## Non-negotiable implementation rules
- Use production-quality TypeScript; no `any` as a default escape hatch.
- No fake front-end-only persistence for features that are supposed to be permanent.
- No raw card data in Wayne's database.
- No service-role secrets in browser code.
- No privileged operation based only on a role value sent by the client.
- No destructive hard deletion of records referenced by historical orders.
- No money arithmetic with floating-point dollars.
- No order workflow that depends on Hanafy Media CRM being online.
- No marketing send without valid consent and suppression checks.
- No phase should break functionality delivered by prior phases.

---

# 1. PRODUCT VISION

Build Wayne's Pizza its own web-based operating system under a Wayne's-owned domain. The same platform should support:

1. A customer-facing website.
2. Online pickup ordering.
3. Online delivery ordering.
4. A front-counter POS for walk-in and phone orders.
5. Kitchen display screens and/or kitchen ticket printing.
6. A delivery-driver workflow.
7. Permanent order history.
8. A calendar-based order browser similar in spirit to Apple Calendar.
9. Menu and website-content management.
10. Owner/manager dashboards and reporting.
11. Customer profiles with lifetime business metrics.
12. Editable customer segments such as VIP, high spender, frequent, and inactive.
13. Event delivery from Wayne's POS to Hanafy Media CRM.
14. A new automation engine inside Hanafy Media CRM.
15. The existing Hanafy campaign manager remaining available for manual promotional broadcasts.
16. Live payment processing added later after the Square merchant account, device selection, credentials, and store workflow are ready.
17. Eventually replacing the current Thrive/Granbury POS only after the new system is proven in parallel.

The system is intended to become the restaurant's operational backbone. Reliability is more important than adding features quickly.

---

# 2. BUSINESS / OPERATING CONTEXT AND CONSTRAINTS

## Current situation
- Wayne's Pizza currently uses a Thrive/Granbury POS.
- The existing system handles front-counter orders, card processing, and ticket printing.
- The legacy POS has been reported at roughly $250/month, and API access may cost substantially more.
- The new build should avoid depending on a paid Thrive API unless a later migration decision specifically justifies it.
- Historical/menu/customer migration should prefer exports/CSV/manual migration tools if available.

## Cost goal
Aim for the new software/hosting stack to be materially cheaper than the existing POS and ideally keep recurring software infrastructure around or below the user's previously discussed ~$150/month target **excluding**:
- credit/debit processing percentage/interchange,
- payment hardware financing/purchases,
- SMS/email usage,
- optional third-party map/address services,
- taxes and other pass-through costs.

Do not promise this target before real usage and vendor pricing are measured.

## Payment plan
The current tentative direction is Square. A Square device/hub/receipt-printing setup around the previously discussed ~$299 price/financing range is under consideration, but the exact hardware model, current price, financing, compatibility, and merchant account are **not yet final**.

Therefore:
- Build payment-provider abstractions early.
- Do not block early development on Square.
- Do not hard-code Square throughout the application.
- Complete live processor/hardware integration in a late phase after the exact device and account are confirmed.
- Do not implement card surcharges/customer-paid processing fees until the processor, card-network rules, and applicable laws are confirmed.

## Domain ownership
The current Wayne's domain may be controlled by the person who currently hosts/rents the restaurant website.

Before production launch:
- Determine the current registrar and legal/account owner of the existing domain.
- Wayne's Pizza / Ehab should control the registrar account and DNS for the long-term production domain.
- If the existing domain cannot be transferred or safely controlled, launch on a new Wayne's-owned domain such as a local-market variant.
- Domain choice must not require code changes; use environment/configuration for canonical domain.

---

# 3. HIGH-LEVEL SYSTEM ARCHITECTURE

```text
                             CUSTOMER WEBSITE
                                   |
                     +-------------+-------------+
                     |                           |
                  PICKUP                      DELIVERY
                     |                           |
                     +-------------+-------------+
                                   |
                              ORDER ENGINE
                                   |
                         SUPABASE / POSTGRES
                                   |
       +-------------------+-------+--------+-------------------+
       |                   |                |                   |
   ADMIN / REPORTS       FRONT POS        KITCHEN             DRIVER
       |                   |                |                   |
       +-------------------+--------+-------+-------------------+
                                   |
                          CUSTOMER INTELLIGENCE
                                   |
                           SEGMENT RULE ENGINE
                                   |
                         INTEGRATION OUTBOX
                                   |
                                   v
                       HANAFY MEDIA CRM API
                                   |
                 +-----------------+------------------+
                 |                                    |
          MANUAL CAMPAIGNS                     AUTOMATIONS
                 |                                    |
                 +------------------+-----------------+
                                    |
                          SMS / EMAIL PROVIDERS
```

## Critical separation of responsibilities
### Wayne's POS owns restaurant truth
Wayne's is authoritative for:
- orders,
- order status,
- totals,
- menu,
- customers,
- lifetime spend,
- order counts,
- last order date,
- restaurant segment membership,
- fulfillment,
- payments and refunds,
- staff actions.

### Hanafy Media CRM owns marketing execution
Hanafy is authoritative for:
- campaigns,
- marketing automations,
- automation runs,
- SMS/email jobs,
- delivery events,
- suppression lists,
- marketing templates,
- marketing message history,
- send windows/frequency caps.

Do not have both systems independently calculate the same restaurant segment rules unless explicitly designed as a mirror/read-only copy.

---

# 4. RECOMMENDED TECHNICAL STACK

## Wayne's application
- Next.js 16+ App Router.
- TypeScript.
- Tailwind CSS.
- Accessible reusable component library such as shadcn/ui.
- Supabase Postgres.
- Supabase Auth.
- Supabase Storage for menu/content images.
- Supabase Realtime for POS, kitchen, driver, and admin live updates.
- Vercel for application hosting.
- Zod or equivalent runtime validation.
- Database migrations committed to the repository.
- Structured logging/error monitoring.

## Hanafy Media CRM
Use the existing Hanafy Media stack wherever possible. Add the automation/event system to the existing CRM instead of rewriting campaign functionality.

## Architectural principles
- One primary Wayne's codebase/app is preferred initially.
- Use feature modules and adapters so hardware/integrations are replaceable.
- Server-side mutations for privileged operations.
- RLS plus server authorization; use both where appropriate.
- Prefer Postgres transactions for order creation and critical state changes.
- Use an outbox pattern for cross-system event delivery.
- Store timestamps in UTC and display restaurant operations in `America/New_York`.
- Store money as integer cents.

---

# 5. ROUTES / SCREEN MAP

## Customer-facing
- `/` — conversion-focused homepage.
- `/order` — pickup vs delivery selection.
- `/menu` — menu browser, optionally fulfillment-aware.
- `/checkout` — checkout flow.
- `/order/[orderId]/status` — order confirmation/status.
- `/about` — Wayne's story / owner Ehab / local SEO content.
- `/contact` — hours, phone, location, contact.

## Admin / owner
- `/admin` — dashboard.
- `/admin/orders` — searchable order list.
- `/admin/calendar` — month/day order calendar.
- `/admin/orders/[id]` — full order detail.
- `/admin/menu` — categories/items/modifiers/photos.
- `/admin/customers` — all customers.
- `/admin/customers/[id]` — full customer profile.
- `/admin/segments` — segment definitions and populations.
- `/admin/reports` — reports/export.
- `/admin/staff` — users/roles/PINs.
- `/admin/integrations` — Hanafy/payment/printer status.
- `/admin/settings` — business settings.
- `/admin/content` — optional website/about content management.
- `/admin/audit` — high-risk activity history.

## Restaurant operations
- `/pos` — front counter/phone-order POS.
- `/kitchen` — kitchen display system.
- `/driver` — delivery driver workflow.

## Hanafy CRM additions — separate codebase
- `/admin/crm/campaigns` — existing/manual campaign lane.
- `/admin/crm/automations` — automation list.
- `/admin/crm/automations/new` — builder.
- `/admin/crm/automations/[id]` — edit/version/publish.
- `/admin/crm/automation-runs` — run history.
- `/admin/crm/events` — incoming event log/debug.
- `/admin/crm/integrations` — Wayne's connection/configuration.

---

# 6. CUSTOMER HOMEPAGE / ORDER-FIRST UX

The first screen should immediately push ordering.

## Required above-the-fold behavior
- Wayne's Pizza logo/name.
- A visually dominant `ORDER NOW` concept centered on screen.
- Screen split into two large tap/click regions:
  - `PICKUP`
  - `DELIVERY`
- On mobile, these may stack vertically instead of side-by-side, but should still dominate the first viewport.
- Pressing anywhere inside the pickup/delivery region should start the corresponding order flow.
- The site must be excellent on phone, tablet, laptop, and desktop.

## Secondary content below the ordering CTA
- Store phone.
- Store address.
- Hours.
- About Wayne's Pizza.
- Owner/family story including Ehab.
- Local area/service information.
- Popular items.
- FAQ.
- Contact section.
- Optional map/location block.

## SEO requirements
- Restaurant/LocalBusiness structured data.
- Unique titles/descriptions.
- Correct canonical URLs.
- Sitemap and robots configuration.
- Clean semantic markup.
- Good performance/Core Web Vitals.
- Image optimization.
- NAP consistency: name/address/phone exactly configured in one canonical settings source.
- About/local content should be useful and not keyword-stuffed.

---

# 7. BUSINESS SETTINGS / STORE CONFIGURATION

Build settings so common operational changes do not require code edits.

Settings should cover:
- Store name.
- Owner/public story content.
- Logo.
- Address.
- Public phone.
- Public email if used.
- Timezone.
- Regular business hours.
- Holiday/special closures.
- Ordering open/closed toggle.
- Pickup enabled/disabled.
- Delivery enabled/disabled.
- Minimum pickup order if desired.
- Minimum delivery order.
- Delivery fee.
- Delivery service area/radius/zones.
- Estimated pickup prep time.
- Estimated delivery time.
- Tax configuration.
- Tip settings.
- Cash acceptance settings.
- Receipt header/footer.
- Website social links.
- Canonical domain.
- Hanafy integration status.
- Payment provider status.
- Printer/KDS routing status.

## Ordering closed behavior
If the store is closed:
- Clearly show closed status.
- Optionally allow scheduling for the next available time only if explicitly enabled later.
- Never accept an ASAP order and silently delay it until the next day.

---

# 8. MENU MODEL AND ADMIN EXPERIENCE

The menu must be completely editable from admin.

## Categories
Examples: Pizza, Calzones, Subs, Wings, Sides, Drinks, Desserts, Specials.

Admin can:
- create,
- edit,
- archive,
- reorder,
- show/hide,
- add category image/description if desired.

## Items
Admin can configure:
- name,
- description,
- image,
- category,
- base price,
- tax category,
- variants/sizes,
- included quantity/count label where relevant,
- modifier groups,
- item availability,
- sold-out/86 toggle,
- day/time availability,
- customer-facing visibility,
- POS visibility,
- kitchen routing category,
- sort order.

## Variants / counts
Support cases like:
- Small / Large pizza.
- 8 wings / 12 wings / 20 wings.
- Can / 2-liter.
- Small / large sub.

Do not force every size/count into a separate unrelated item if variants model it naturally.

## Modifiers
Support:
- required/optional groups,
- minimum/maximum selections,
- single/multiple choice,
- price deltas,
- quantities,
- default selections,
- customer-facing labels.

Pizza model must be flexible enough for:
- size,
- toppings,
- extra toppings,
- crust/style if needed,
- half-and-half later if Wayne's decides to support it online.

## Item photos
- Upload to Supabase Storage.
- Crop/resize/optimize.
- Maintain alt text.
- Do not let orphaned historical orders depend on current images.

## Historical integrity
Never hard-delete a menu item referenced by an order. Archive instead.
Old orders preserve item/variant/modifier names and prices as snapshots.

---

# 9. CUSTOMER ORDERING FLOW

## Step 1 — fulfillment
Customer chooses:
- Pickup.
- Delivery.

The selected fulfillment type should remain visible and changeable until checkout.

## Step 2 — menu
- Browse categories.
- Search if useful.
- Open item detail/modal.
- Configure modifiers.
- Add quantity.
- Add item instructions.
- Add to cart.

## Step 3 — cart
Show:
- item names,
- variants,
- modifiers,
- quantities,
- line prices,
- subtotal,
- discounts,
- delivery fee,
- tax,
- tip if enabled,
- grand total.

Customer can edit/remove items before checkout.

## Step 4 — customer information
Required for non-anonymous online orders:
- first name,
- last name,
- phone.

Optional/conditional:
- email,
- delivery address,
- apartment/unit,
- delivery instructions.

### Customer identity
- Canonical identity is an internal UUID.
- Normalize phone and use it as the strongest practical returning-customer dedupe/matching signal.
- Email is secondary.
- Address is not the customer primary key.
- Multiple people may share an address.
- One person may have multiple addresses.
- A later household feature may group contacts at one address.

## Step 5 — marketing consent
Ordering contact information is not automatic marketing permission.

Provide separate opt-ins such as:
- `[ ] Send me Wayne's Pizza text deals`.
- `[ ] Send me Wayne's Pizza email deals`.

Store:
- consent state,
- timestamp,
- source,
- exact/hashed consent text version,
- IP/user-agent if legally/operationally appropriate,
- opt-out history.

## Step 6 — payment during early phases
Until live Square/payment integration is ready:
- use a clearly labeled `TEST / MANUAL` payment mode in staging/development,
- optionally support cash designation for internal POS testing,
- do not present fake card entry to real customers as if it were production.

## Step 7 — confirmation
A successful order must:
- save permanently,
- generate a human-readable order number,
- snapshot customer/order/menu details,
- appear in admin order history,
- appear on the calendar,
- publish to KDS/print queue,
- update customer metrics,
- show customer confirmation/status,
- later create transactional message jobs as configured.

---

# 10. ORDER SOURCES AND TYPES

Every order uses the same canonical order model regardless of source.

Sources:
- `online` — customer website.
- `pos` — walk-in/front counter.
- `phone` — staff-entered phone order.
- `admin` — manager-created/manual correction if needed.

Fulfillment:
- `pickup`.
- `delivery`.

This ensures online, phone, and walk-in orders all appear together in dashboard, calendar, reports, customer history, kitchen, and customer metrics.

---

# 11. ORDER STATE MACHINE

Use explicit controlled states.

Recommended order states:
- `draft`
- `payment_pending`
- `placed`
- `accepted`
- `in_kitchen`
- `ready`
- `out_for_delivery`
- `completed`
- `cancelled`

Payment state is separate:
- `unpaid`
- `authorized`
- `paid`
- `partially_refunded`
- `refunded`
- `failed`

Every meaningful transition writes an immutable `order_events` row.

## Example pickup flow
`placed -> accepted -> in_kitchen -> ready -> completed`

## Example delivery flow
`placed -> accepted -> in_kitchen -> ready -> out_for_delivery -> completed`

## Cancellation
- Record actor, reason, time, and refund/void impact.
- Never erase the original order.

---

# 12. FRONT-COUNTER POS

The POS must be fast and touch-friendly.

## Layout
Suggested tablet/desktop arrangement:
- Category bar/rail.
- Large item grid.
- Current ticket on the right or bottom on smaller screens.
- Customer/fulfillment info always easy to access.
- Search.
- Large buttons.

## POS workflows
### Walk-in pickup
1. New ticket.
2. Choose walk-in/anonymous or identify customer.
3. Pickup.
4. Add items/modifiers.
5. Choose payment method/status allowed for current development phase.
6. Submit.
7. Send to kitchen.

### Phone order
1. Search customer by phone.
2. If match, load name/addresses/history summary.
3. If no match, create customer.
4. Choose pickup/delivery.
5. For delivery, choose/add address.
6. Add items/modifiers.
7. Add notes.
8. Confirm totals/time.
9. Submit.
10. Send to kitchen/driver flow.

## Fast customer lookup
Search by:
- phone,
- name,
- order number if context requires.

## Permissions
Cashiers cannot by default:
- edit global menu prices,
- alter business integrations,
- change taxes,
- issue large refunds,
- perform unrestricted discounts,
- edit staff roles.

Manager override should be auditable.

---

# 13. KITCHEN DISPLAY SYSTEM AND PRINTING

Wayne's may use one or more small tablets in the back and/or physical kitchen printers.
The architecture must allow both.

## KDS
The `/kitchen` view should:
- receive new orders in real time,
- show oldest actionable orders first,
- visually distinguish pickup and delivery,
- show large order number,
- show item/modifier details clearly,
- show customer/special instructions,
- show timer since placed/accepted,
- support touch actions.

Actions:
- Accept.
- Start / In Kitchen.
- Ready.

When ready:
- Pickup order becomes ready for counter/customer notification.
- Delivery order becomes ready for driver assignment/pickup.

## Multiple kitchen stations
Design routing so later Wayne's can map categories/items to stations, for example:
- Pizza -> station/printer A.
- Fry/sides -> station/printer B.
- Front receipt -> front printer.

Do not require this split in the first KDS milestone, but the schema/print job model must not block it.

## Print queue
Orders must not be lost if a printer is offline.

Recommended design:
1. Order saved in cloud database.
2. Print job record created.
3. Local print agent or supported cloud/network integration reads pending jobs.
4. Print result is acknowledged.
5. Failed jobs retry and are visible in admin.

Hardware-specific ESC/POS logic belongs behind a printer adapter.

---

# 14. ADMIN DASHBOARD

`/admin` is the first owner/manager screen.

## Daily headline metrics
- Gross sales today.
- Net sales today.
- Grand total / relevant total clearly labeled.
- Order count.
- Average order value.
- Pickup sales and order count.
- Delivery sales and order count.
- Online sales and count.
- POS/phone/walk-in sales and count.
- Card sales and count.
- Cash sales and count.
- Discounts.
- Refunds.
- Tips if enabled.

## Visuals / tables
- Sales by hour.
- Orders by hour.
- Recent orders.
- Top-selling items.
- Pickup vs delivery mix.
- Payment-method mix.
- New vs returning customer mix.

## Time filters
- Today.
- Yesterday.
- This week.
- Last week.
- Month to date.
- Custom date range.

Reporting must use the Wayne's local business day in `America/New_York`, even though timestamps are stored in UTC.

---

# 15. ORDER CALENDAR — REQUIRED UX

This is a major requested admin feature.

The concept should resemble a simple modern monthly calendar rather than copying Apple Calendar exactly.

## Month view
Header example:

```text
<        September 2026        >

SUN  MON  TUE  WED  THU  FRI  SAT
```

Requirements:
- Previous-month arrow.
- Next-month arrow.
- Current month/year.
- Standard month grid.
- Days clickable/tappable.
- Today visually recognizable.
- Optional tiny daily summary such as order count and sales amount.
- Optional dots/indicators for pickup, delivery, or other categories.

## Clicking a date
Open a panel/page containing every order for that day.

Show:
- time placed,
- order number,
- customer name,
- phone,
- pickup/delivery,
- source,
- payment method,
- total,
- status.

## Clicking an order
Open full permanent order detail:
- items,
- modifiers,
- quantities,
- item notes,
- original price snapshots,
- subtotal/discount/tax/delivery/tip/total,
- customer snapshot,
- current customer profile link,
- delivery-address snapshot,
- payment history,
- refund history,
- order timeline,
- staff actors,
- kitchen timestamps,
- driver assignment/timestamps,
- integration/event history useful for debugging.

## Search across orders
Admin order search should find orders by:
- order number,
- name,
- normalized phone,
- date/date range,
- fulfillment type,
- source,
- status,
- payment method.

---

# 16. CUSTOMER DATABASE / CUSTOMER INTELLIGENCE

Each returning customer should have a persistent profile.

## Customer list
Columns/filters:
- name,
- phone,
- email,
- last order,
- first order,
- total orders,
- lifetime spend,
- average order value,
- current segments,
- SMS consent,
- email consent.

## Customer detail
Show:
- customer ID,
- name,
- phone(s) if later supported,
- email,
- addresses,
- notes,
- consent history,
- first order,
- last order,
- total orders,
- lifetime spend,
- AOV,
- full order history,
- current segments,
- past segment membership,
- recent marketing activity summary if synced from Hanafy.

## Metrics
After a completed/qualifying order, update or recompute:
- order count,
- lifetime spend,
- average order value,
- first order date,
- last order date,
- days since last order,
- optionally purchase frequency/recency metrics later.

Metrics cached on the customer table must always be reproducible from authoritative order data.

## Customer merge/deduplication
Later admin functionality should allow a manager to merge accidental duplicate customer records without losing order history.
All merges must be auditable.

---

# 17. CUSTOMER SEGMENTATION ENGINE

Wayne's must have an admin-editable segment/rule system.

Initial segments can include:
- All customers.
- Text Club / SMS-consented.
- Email-consented.
- VIP.
- High spender.
- Frequent customer.
- New customer.
- At risk.
- 30-day inactive.
- 60-day inactive.
- 90-day inactive.

## Example rules
### VIP
```json
{
  "all": [
    {"field":"lifetime_spend_cents","operator":">=","value":100000},
    {"field":"order_count","operator":">=","value":20}
  ]
}
```

### High spender
```json
{
  "all": [
    {"field":"lifetime_spend_cents","operator":">=","value":50000}
  ]
}
```

### Frequent
```json
{
  "all": [
    {"field":"orders_last_30_days","operator":">=","value":3}
  ]
}
```

### 30-day inactive
```json
{
  "all": [
    {"field":"days_since_last_order","operator":">=","value":30},
    {"field":"order_count","operator":">=","value":2}
  ]
}
```

Actual thresholds must be editable by owner/manager; these are defaults/examples, not permanent hard-coded business logic.

## Segment membership history
Track:
- entered_at,
- exited_at,
- active status.

When membership changes, create a domain event such as:
- `customer.segment.entered`
- `customer.segment.exited`

## Evaluation strategy
- Reevaluate immediately after relevant order/customer changes.
- Run a scheduled/nightly evaluator for time-based rules such as inactivity.
- Do not schedule one 30-day timer for every customer.

---

# 18. PROMO / DISCOUNT SYSTEM

Support promotion codes and controlled POS discounts.

## Promo code properties
- code,
- percent/fixed discount,
- minimum order,
- start/end dates,
- fulfillment restrictions,
- eligible items/categories if later needed,
- total usage limit,
- per-customer usage limit,
- active state.

## POS discounts
- Fixed/percent discount.
- Reason required for manager-level manual discounts.
- Permission thresholds.
- Audit actor/time/reason.

Historical orders store the applied discount snapshot/result, not only a pointer to a currently editable promotion.

---

# 19. DELIVERY OPERATIONS

## Delivery settings
Support configuration for:
- enabled/disabled,
- service radius or zones,
- delivery minimum,
- delivery fee,
- estimated delivery time.

Validate delivery eligibility before order submission.

## Driver screen
Driver sees only relevant assigned/available delivery information:
- order number,
- customer name,
- phone,
- address,
- delivery instructions,
- order total,
- amount due if applicable,
- status.

Actions:
- accept assignment,
- picked up,
- open navigation,
- delivered,
- record cash collected.

Later, if supported by selected Square/payment configuration:
- initiate card-present/tap payment on the driver's approved mobile hardware/phone workflow.

## Owner driver analytics
- deliveries per driver,
- total delivered,
- cash collected,
- average delivery time,
- delivery status exceptions.

---

# 20. PAYMENT ARCHITECTURE — DEFER LIVE PROCESSOR UNTIL LATER

Do not make Square setup a blocker for early phases.

## Provider abstraction
Create a payment service interface, for example:
- `createOnlinePayment()`
- `createCardPresentPayment()`
- `capturePayment()`
- `voidPayment()`
- `refundPayment()`
- `getPaymentStatus()`
- `handleWebhook()`

The rest of the order system should depend on the interface, not Square SDK calls scattered through components.

## Later Square phase
After Wayne's has:
- the merchant account,
- final hardware decision,
- credentials,
- tested terminal/device,
- receipt workflow confirmed,

implement the Square adapter for:
- customer online card payment,
- front-counter card-present payment,
- receipt/terminal flow,
- refunds/voids,
- payment webhooks,
- reconciliation,
- optional delivery/mobile card payment if the chosen setup supports it.

## Failure safety
Handle:
- payment succeeds but browser closes,
- provider webhook arrives before/after browser callback,
- duplicate webhooks,
- terminal temporarily offline,
- payment authorized but order save response interrupted,
- refund retries.

Use idempotency keys and provider webhook reconciliation.

---

# 21. CASH, DRAWERS, SHIFTS, AND DAY CLOSE

Before replacing the existing POS, support restaurant cash reconciliation.

Features:
- register/drawer identity,
- shift open,
- opening cash,
- cash sales,
- paid-ins,
- paid-outs,
- refunds,
- expected cash,
- counted cash,
- variance,
- shift/day close.

Owner/manager receives a closeout report.
All cash adjustments require an actor and reason.

---

# 22. STAFF AUTHENTICATION, ROLES, AND DEVICE UX

## Roles
At minimum:
- Owner.
- Manager.
- Cashier.
- Kitchen.
- Driver.
- Marketing/read-only if useful.

## Admin auth
Use secure user accounts for owner/manager.

## Fast POS staff switching
Recommended:
1. Register/authorize the store device.
2. Staff uses individual PIN or quick switch.
3. Every ticket, void, refund, discount, and sensitive action is attributed to an individual staff user.

Do not use one shared owner password for everyone.

## Audit-required actions
Track:
- refunds,
- voids,
- cancellations,
- discounts,
- price overrides,
- menu changes,
- tax/settings changes,
- integration setting changes,
- staff role changes,
- customer merges,
- replaying integration events.

---

# 23. HANAFY MEDIA CRM INTEGRATION — WAYNE'S SIDE

The POS must never directly depend on Hanafy being available during checkout.

## Events Wayne's should emit
At minimum:
- `order.created`
- `order.paid`
- `order.completed`
- `order.cancelled`
- `customer.created`
- `customer.updated`
- `customer.metrics.updated`
- `customer.consent.changed`
- `customer.segment.entered`
- `customer.segment.exited`

Potential later events:
- `delivery.completed`
- `customer.merged`
- `promo.redeemed`

## Event envelope
```json
{
  "event_id": "uuid",
  "event_type": "customer.segment.entered",
  "occurred_at": "2026-09-07T20:00:00Z",
  "source": "waynes-pos",
  "business_id": "waynes-pizza",
  "version": 1,
  "data": {
    "customer_id": "uuid",
    "segment": "30-day-inactive"
  }
}
```

## Outbox pattern
Within the same transaction that commits a relevant Wayne's change:
1. Save the authoritative business change.
2. Insert an `integration_outbox` row.
3. Commit.
4. Background worker delivers pending outbox events.
5. Retry failures with backoff.
6. Keep delivery logs.
7. Admin can safely replay a failed event.

Therefore an outage in Hanafy, AWS SMS, or email does not stop Wayne's from taking orders.

## Security
- HTTPS.
- HMAC signature.
- Timestamp header.
- Replay-window validation.
- Unique `event_id` idempotency.
- Per-business integration secret.
- Secret rotation capability.

## Customer synchronization
Sync only the fields Hanafy needs for marketing:
- external Wayne's customer UUID,
- name,
- phone,
- email,
- consent state,
- order count,
- lifetime spend,
- AOV,
- last order,
- current segments.

Do not copy the entire POS database into Hanafy unless a real automation use case needs a field.

---

# 24. HANAFY MEDIA CRM — REQUIRED NEW AUTOMATION ENGINE

This is a separate development effort inside the existing Hanafy Media CRM.
Do not rebuild or remove the existing Campaign Manager.

The CRM should have **two marketing lanes**.

## Lane A — Campaign Manager
Manual one-time/broadcast sends.

Example:
Wayne's wants to promote a weekly deal to its Text Club.

Flow:
1. Select Wayne's Pizza business/tenant.
2. New campaign.
3. Choose SMS or email.
4. Choose audience.
5. Write/select message.
6. Preview/test.
7. Schedule/send.
8. Track results.

Audience selection should support Wayne's synced segments such as:
- Text Club / all SMS-consented.
- Email-consented.
- VIP.
- High spender.
- Frequent.
- 30/60/90-day inactive.
- Custom filters based on synced metrics.

Before sending show:
- estimated recipients,
- suppressed/excluded count,
- message preview,
- personalization preview,
- estimated SMS segments/cost if available,
- test send.

## Lane B — Automation Engine
Event-driven workflows.

Example:
```text
TRIGGER
Customer enters 30-Day Inactive

CONDITIONS
SMS consent = yes
Order count >= 2

TIMING
Send immediately or inside allowed hours

ACTION
Send Wayne's 30-Day Winback SMS
```

## Minimum workflow builder
### Trigger
- incoming event type,
- optional trigger property filter.

Examples:
- segment entered,
- segment exited,
- order completed,
- customer created,
- birthday/time-based later.

### Conditions
Examples:
- SMS consent true,
- email consent true,
- phone/email exists,
- lifetime spend threshold,
- order-count threshold,
- current segment contains VIP,
- last message older than X days,
- source/business match.

### Timing
- immediate,
- delay X minutes/hours/days,
- allowed send window,
- quiet hours.

### Actions
Initial:
- send SMS,
- send email,
- add/remove Hanafy tag,
- update marketing field.

Later:
- internal notifications,
- webhook/custom action if justified.

### Workflow controls
- draft,
- published,
- paused,
- duplicate,
- version history,
- dry-run/test mode,
- priority,
- execution cap per contact,
- cooldown/frequency cap.

## CRM incoming event flow
```text
Wayne's POS outbox
  -> signed request
Hanafy event endpoint
  -> verify HMAC + timestamp
  -> dedupe event_id
  -> store crm_event
  -> match published automations
  -> create automation_run
  -> evaluate conditions
  -> delay if needed
  -> queue SMS/email job
  -> provider send
  -> delivery result / STOP / bounce
  -> execution + message history
```

## Existing AWS messaging
Use Hanafy's existing AWS SMS infrastructure rather than making Wayne's POS send marketing SMS directly.
The automation engine and campaign manager should both feed the same normalized Hanafy messaging job layer so:
- opt-outs are shared,
- provider behavior is consistent,
- delivery logs are centralized,
- business-level usage/cost can be measured.

Email should use the existing/final Hanafy email delivery layer through the same general job pattern.

## Required automation tables/services — conceptual
- `business_integrations`
- `crm_contacts`
- `crm_events`
- `automation_workflows`
- `automation_versions`
- `automation_runs`
- `automation_run_steps`
- `message_jobs`
- `message_delivery_events`
- `suppression_entries`
- optionally `automation_delays`/scheduled jobs depending on implementation.

## Idempotency rules
- A duplicate `event_id` must not create a second event or second automation run.
- Retrying a failed automation step must not duplicate a previously successful send.
- Provider delivery/webhook events must also be deduped.

## Explainability
For every automation run, a manager should be able to answer:
- What event triggered this?
- Which workflow/version ran?
- Which conditions passed/failed?
- Was it delayed?
- Was a message suppressed?
- What message/template was used?
- Did the provider accept/deliver/fail it?

---

# 25. MARKETING CONSENT / STOP / SUPPRESSION RULES

Separate transactional and marketing communication.

Transactional examples:
- order confirmation,
- order-ready notice,
- delivery status.

Marketing examples:
- win-back coupon,
- weekly Text Club special,
- VIP promotion.

Marketing send rules:
- SMS requires valid SMS marketing consent and no suppression/STOP.
- Email marketing requires appropriate email consent/status and no unsubscribe/suppression.
- STOP/unsubscribe always overrides automation/campaign audience membership.
- Consent changes should sync between Hanafy and Wayne's where practical.
- Keep an auditable consent timeline.
- Preserve existing 10DLC-compliant HELP/STOP/opt-in language in the Hanafy messaging program.

---

# 26. REPORTING

## Initial reports
- Sales by date.
- Sales by hour.
- Orders by source.
- Orders by fulfillment.
- Orders by payment method.
- Sales by category.
- Sales by item.
- Discounts/promos.
- Refunds.
- Top customers.
- Returning customer rate.
- Lifetime spending.
- Inactive customer counts.
- Segment populations.
- Delivery performance.
- Staff/shift activity where appropriate.

## Export
CSV export for:
- orders,
- customers,
- sales summaries,
- report results where useful.

All report totals must reconcile to authoritative orders/payments rather than independently calculated UI guesses.

---

# 27. NOTIFICATIONS AND TRANSACTIONAL COMMUNICATION

Design a transactional notification interface even if provider delivery is implemented later.

Potential transactional messages:
- online order received,
- order accepted,
- pickup ready,
- delivery out for delivery,
- cancellation/refund confirmation.

Rules:
- Transactional messages are not sent through a marketing automation just to avoid consent rules.
- Marketing and transactional templates/history should remain distinguishable.
- Failure to send a notification must never roll back an already valid order.

---

# 28. DATABASE / DATA MODEL

Exact schema may evolve, but preserve these entities and relationships.

## Authentication / staff
### `roles`
- id
- name
- permissions_json or normalized permission tables

### `profiles`
- id
- auth_user_id
- first_name
- last_name
- role_id
- active
- created_at
- updated_at

### `registered_devices` later/if needed
- id
- name
- device_type
- active
- last_seen_at

## Customers
### `customers`
- id UUID
- first_name
- last_name
- phone_normalized
- email_normalized
- first_order_at
- last_order_at
- order_count
- lifetime_spend_cents
- average_order_value_cents
- sms_marketing_opt_in
- email_marketing_opt_in
- notes
- created_at
- updated_at

### `customer_addresses`
- id
- customer_id
- label
- address1
- address2
- city
- state
- postal_code
- latitude nullable
- longitude nullable
- delivery_instructions
- is_default
- created_at

### `marketing_consents`
- id
- customer_id
- channel
- status
- source
- consent_text_version
- occurred_at
- metadata

## Menu
### `menu_categories`
- id
- name
- description
- image_url
- sort_order
- active

### `menu_items`
- id
- category_id
- name
- description
- image_url
- base_price_cents
- active
- sold_out
- sort_order
- tax_category
- kitchen_route nullable
- availability_json or normalized schedule relation

### `menu_item_variants`
- id
- menu_item_id
- name
- price_cents
- sku nullable
- active
- sort_order

### `modifier_groups`
- id
- name
- min_select
- max_select
- required
- active
- sort_order

### `modifier_choices`
- id
- modifier_group_id
- name
- price_delta_cents
- active
- sort_order

### `menu_item_modifier_groups`
join relation between item/variant and modifier groups.

## Orders
### `orders`
- id UUID
- order_number human-readable/unique
- customer_id nullable
- source
- fulfillment_type
- status
- payment_status
- payment_method
- subtotal_cents
- discount_cents
- delivery_fee_cents
- tax_cents
- tip_cents
- total_cents
- customer_name_snapshot
- customer_phone_snapshot
- customer_email_snapshot
- delivery_address_snapshot JSONB
- special_instructions
- placed_at
- promised_at
- accepted_at
- ready_at
- out_for_delivery_at nullable
- completed_at
- cancelled_at
- created_by_user_id nullable
- idempotency_key nullable/unique where applicable
- created_at
- updated_at

### `order_items`
- id
- order_id
- menu_item_id nullable
- variant_id nullable
- item_name_snapshot
- variant_name_snapshot
- unit_price_cents
- quantity
- line_total_cents
- special_instructions

### `order_item_modifiers`
- id
- order_item_id
- modifier_name_snapshot
- price_delta_cents
- quantity

### `order_events`
- id
- order_id
- event_type
- from_status
- to_status
- actor_user_id nullable
- metadata
- created_at

## Payments
### `payments`
- id
- order_id
- provider
- provider_payment_id
- method
- amount_cents
- status
- authorized_at
- captured_at
- failed_at
- metadata

### `refunds`
- id
- payment_id
- order_id
- amount_cents
- reason
- provider_refund_id
- created_by_user_id
- created_at

## Delivery
### `delivery_assignments`
- id
- order_id
- driver_user_id
- assigned_at
- accepted_at
- picked_up_at
- delivered_at
- status
- cash_collected_cents nullable

## Segments
### `customer_segments`
- id
- name
- description
- active
- priority
- rules_json
- created_at
- updated_at

### `customer_segment_memberships`
- customer_id
- segment_id
- entered_at
- exited_at nullable
- active

## Promotions
### `promo_codes`
- id
- code
- discount_type
- discount_value
- min_order_cents
- start_at
- end_at
- usage_limit
- per_customer_limit
- restrictions_json
- active

## Integration
### `integration_outbox`
- id
- event_id unique
- destination
- event_type
- payload
- status
- attempts
- next_attempt_at
- last_error
- created_at
- delivered_at

### `integration_delivery_logs`
- id
- outbox_id
- attempt_number
- request_status
- response_code
- response_body_truncated
- attempted_at

## Print jobs
### `print_jobs`
- id
- order_id
- destination/station
- job_type
- payload or render_data
- status
- attempts
- last_error
- created_at
- printed_at

## Store config
### `store_settings`
Can be one validated row/JSON config or normalized settings tables. Must include operational settings listed earlier.

## Cash/shift
Add normalized tables for:
- registers/drawers,
- shifts,
- cash movements,
- closing counts.

---

# 29. DATA INTEGRITY RULES

1. UUID internal IDs.
2. Money stored in integer cents.
3. Timestamps stored in UTC.
4. Store-facing times rendered in `America/New_York`.
5. Historical orders use snapshots.
6. Menu edits never rewrite old orders.
7. Customer edits never rewrite old order contact snapshots.
8. Archive/soft-delete operational records that may be historically referenced.
9. Order creation is transactional.
10. Checkout uses idempotency protection.
11. Webhook/event consumers use idempotency protection.
12. Report totals derive from authoritative records.
13. Customer cached metrics are recomputable.
14. Every sensitive/manual override is audited.

---

# 30. SECURITY REQUIREMENTS

- Supabase RLS on private tables.
- Server-side authorization for every privileged mutation.
- Never expose service-role keys to browser.
- Strict input validation.
- Rate-limit public write endpoints.
- Secure auth/session handling.
- HMAC verify integration webhooks.
- Validate webhook timestamp/replay window.
- Environment/secret manager for secrets.
- Access-control least privilege.
- Database backups enabled.
- Audit logs for risky actions.
- No raw PAN/CVV/card magnetic data stored.
- Protect customer PII and limit staff access by role.
- Prevent cross-tenant Hanafy CRM access when multiple client businesses exist.

---

# 31. RELIABILITY / FAILURE SCENARIOS THAT MUST BE DESIGNED FOR

Before launch, explicitly test:
- Customer double-clicks `Place Order`.
- Browser refreshes during submission.
- Network disconnects after request reaches server.
- Kitchen tablet refreshes/reconnects.
- Supabase Realtime reconnects after outage.
- Printer goes offline.
- Print agent restarts.
- Hanafy CRM is offline for hours.
- AWS messaging is unavailable.
- Payment provider is unavailable.
- Payment succeeds but client never receives confirmation response.
- Provider webhook is duplicated.
- Provider webhook arrives out of order.
- Customer abandons checkout.
- Item becomes sold out while in cart.
- Menu price changes while another customer has item in cart.
- Two managers edit the same menu item.
- Order is cancelled after kitchen accepted it.
- Full refund.
- Partial refund.
- Cash refund.
- Delivery is reassigned.
- DST clock transition.
- App deployment occurs during active store hours.

The system should fail visibly and recoverably rather than silently lose orders.

---

# 32. OBSERVABILITY / ADMIN SUPPORT TOOLS

Production needs debugging visibility.

Include:
- structured server logs,
- error tracking,
- request/event correlation IDs,
- payment webhook logs,
- Hanafy event delivery logs,
- print queue health,
- realtime/KDS connection status,
- admin integration status screen,
- safe event replay,
- failed print requeue,
- failed notification retry where appropriate.

Never expose secrets/raw sensitive provider payloads unnecessarily in UI logs.

---

# 33. MIGRATION FROM CURRENT POS

Do not require live Thrive API access as a prerequisite.

Migration plan:
1. Obtain/export current Wayne's menu.
2. Build menu import helper if useful.
3. Export customer contacts/order history if the existing system allows it and Wayne's is entitled to the data.
4. Normalize phone/email data.
5. Import customers carefully with dedupe preview.
6. Import useful historical orders only if reliable data exists; otherwise establish a clean go-live date and preserve legacy exports separately.
7. Verify taxes/menu prices manually.
8. Parallel-run old and new systems.
9. Reconcile daily totals and kitchen tickets.
10. Train staff.
11. Cut over only after reliability checklist passes.

---

# 34. PHASED BUILD PLAN

## Phase 0 — Foundation
Build only:
- repository/app foundation,
- Next.js/TypeScript/Tailwind,
- Supabase setup,
- migrations system,
- environments (local/staging/production),
- auth,
- roles/permissions skeleton,
- route protection,
- reusable design system,
- base logging/error handling,
- seed script.

Acceptance:
- owner can sign in,
- unauthorized users cannot enter admin,
- role checks work server-side,
- migrations apply from clean database,
- RLS tests pass,
- build/typecheck/lint pass.

---

## Phase 1 — Public Site + Menu Admin
Build:
- homepage order-first UI,
- pickup/delivery CTA,
- About/Contact/local SEO content,
- business settings required by public site,
- categories,
- items,
- variants,
- modifiers,
- images,
- sold-out/archive,
- public menu rendering.

Acceptance:
- owner can create a category and an item with variant/modifiers/image,
- customer can see it correctly,
- sold-out and archived behavior works,
- historical-safe archive pattern exists,
- responsive behavior works on phone/tablet/desktop.

---

## Phase 2 — Cart + Customers + Test Order Creation
Build:
- fulfillment state,
- cart,
- customer capture,
- phone normalization,
- address records,
- marketing opt-in capture,
- tax/delivery/discount calculations,
- order snapshots,
- idempotent order creation,
- test/manual payment mode,
- confirmation/status page.

Do not wait on Square.

Acceptance:
- customer can complete a test pickup order,
- customer can complete a test delivery order,
- duplicate click does not create duplicate order,
- order details persist after refresh,
- old order snapshots remain correct after menu/customer edits.

---

## Phase 3 — Admin Orders + Calendar
Build:
- order list,
- order detail,
- order timeline,
- search/filters,
- month calendar,
- day drill-down,
- daily summary indicators.

Acceptance:
- every test order can be found by date/order number/name/phone,
- calendar totals exactly match order data,
- clicking date and order behaves as specified,
- mobile calendar drill-down is usable.

---

## Phase 4 — Front POS
Build:
- `/pos`,
- touch item grid,
- customer lookup/create,
- phone order flow,
- walk-in flow,
- pickup/delivery,
- modifiers,
- notes,
- test/manual payment method,
- controlled discounts,
- order submit.

Acceptance:
- staff can enter a normal phone order quickly,
- staff can enter walk-in order,
- both save into exact same order model as online orders,
- customer history/metrics update correctly.

---

## Phase 5 — Kitchen/KDS + Print Queue Abstraction
Build:
- `/kitchen`,
- realtime order appearance,
- accept/start/ready,
- timers,
- reconnect behavior,
- print_jobs model,
- printer adapter interface,
- optional first local print agent proof of concept.

Acceptance:
- online and POS orders reach KDS within seconds,
- refresh/reconnect restores current tickets,
- state transitions persist,
- printer failure never loses order,
- failed print job can be retried.

### First major vertical-slice milestone
At the end of Phase 5, this entire loop must be solid:

**Admin creates menu -> customer chooses pickup/delivery -> customer orders -> order is permanently stored -> order appears in admin/calendar -> order appears in front POS/order system -> order appears live in kitchen.**

Do not race into advanced CRM work until this backbone is reliable.

---

## Phase 6 — Dashboard + Core Reports
Build:
- dashboard cards,
- sales/order charts,
- source/fulfillment splits,
- basic item reporting,
- date filters,
- CSV exports for initial data sets.

Acceptance:
- all totals reconcile to authoritative orders,
- refunds/discounts affect net reporting correctly,
- business-day timezone boundaries are correct.

---

## Phase 7 — Customer Intelligence + Segments
Build:
- customer list/detail,
- metrics updater/rebuilder,
- segment editor,
- segment evaluator,
- segment membership history,
- nightly inactivity evaluator,
- segment population views.

Acceptance:
- order changes update customer metrics correctly,
- editable VIP/high-spender/frequent rules work,
- 30/60/90-day inactivity works,
- segment enter/exit events are generated exactly when membership changes.

---

## Phase 8 — Wayne's -> Hanafy Event Integration
Build in Wayne's:
- HMAC event envelope,
- outbox table/service,
- retry worker,
- delivery log,
- customer/segment property sync,
- admin integration health,
- safe replay.

Acceptance:
- Wayne's continues taking orders with Hanafy offline,
- failed events retry later,
- duplicate delivery is safe,
- event logs make failures diagnosable.

---

## Phase 9 — Hanafy CRM Automation Engine
Build in Hanafy codebase:
- event ingestion endpoint,
- business integration configuration,
- contact upsert by external Wayne's customer ID,
- incoming event log,
- automation list,
- workflow builder,
- trigger filters,
- conditions,
- timing/delays,
- send windows,
- SMS/email actions,
- automation queue/worker,
- version/publish/pause,
- dry-run/test,
- execution logs,
- suppression/frequency caps,
- integration with existing AWS SMS messaging job layer,
- keep Campaign Manager intact for manual sends.

Acceptance:
- a test `customer.segment.entered` event creates exactly one run,
- matching workflow executes,
- non-matching workflow does nothing,
- paused/draft workflow does nothing,
- duplicate event does not duplicate send,
- opted-out customer is suppressed,
- run history explains every decision.

---

## Phase 10 — Delivery Driver Module
Build:
- driver role/screen,
- assign delivery,
- accept,
- pickup,
- navigation handoff,
- delivered,
- cash collected,
- owner delivery metrics.

Keep card-at-door disabled until live payment integration exists.

Acceptance:
- a ready delivery can be assigned,
- driver sees required information,
- owner sees status live,
- cash collection is auditable.

---

## Phase 11 — Live Square / Payment Processor + Receipt Hardware
Start only after merchant account and exact Square hardware/setup are confirmed.

Build:
- Square provider adapter,
- online card checkout,
- front-counter card-present transaction,
- provider webhooks,
- reconciliation,
- void/refund,
- receipt terminal/printer flow,
- optional approved driver/tap-to-pay workflow if supported.

Acceptance:
- real test payment succeeds end-to-end,
- failed payment produces no false paid state,
- duplicate webhook safe,
- browser-close recovery works,
- refund audited,
- receipt workflow tested on actual Wayne's hardware.

---

## Phase 12 — Cash Drawer / Shift / Closeout
Build:
- registers/drawers,
- opening cash,
- cash movements,
- expected vs counted,
- variance,
- manager closeout report.

Acceptance:
- test day cash reconciles exactly,
- paid-in/out and refunds are reflected,
- actor/reason history is complete.

---

## Phase 13 — Production Hardening + Migration + Cutover
Build/do:
- final menu/customer import,
- real printer routing,
- actual hardware install,
- production secrets,
- backups,
- monitoring,
- staff accounts/PINs,
- training,
- load/concurrency testing,
- parallel operation with legacy POS,
- end-of-day reconciliation,
- domain/DNS cutover,
- final go-live checklist.

Acceptance:
- Wayne's team can run a full service period on new system,
- no orders are lost,
- cash/card/tax totals reconcile,
- KDS/printing stable,
- payment stable,
- driver workflow stable,
- CRM outage cannot stop POS,
- staff permissions/audit work,
- production owner controls domain and critical accounts.

---

# 35. TEST PLAN — REQUIRED CATEGORIES

Every phase should add tests appropriate to the feature.

## Unit tests
Examples:
- money calculations,
- tax calculations,
- discount rules,
- customer metric calculations,
- segment rule evaluation,
- state transition validation,
- event signature verification.

## Integration tests
Examples:
- order transaction creates order/items/events/outbox atomically,
- customer upsert and order link,
- segment change writes event,
- event retry/dedupe,
- payment webhook reconciliation.

## End-to-end tests
At minimum eventually cover:
- customer pickup order,
- customer delivery order,
- staff phone order,
- KDS completion,
- calendar lookup,
- customer metric/segment update,
- Hanafy automation test event,
- refund,
- shift close.

## Manual hardware tests
Required later for:
- card terminal,
- receipt printer,
- kitchen printer,
- driver/mobile payment,
- cash drawer if connected.

---

# 36. UI / UX QUALITY BAR

This is not an internal developer demo. It is a real restaurant system.

Requirements:
- Responsive.
- Fast on modest tablets/phones.
- Large touch targets on POS/KDS.
- Clear loading and error states.
- No tiny hidden controls required during rush periods.
- Avoid unnecessary animations on operational screens.
- Confirmation before destructive/high-risk actions.
- Keyboard support where useful on admin desktop.
- Accessible labels/contrast.
- POS/KDS should not require scrolling through unnecessary dashboard content.
- Customer checkout should have as few steps as practical.

---

# 37. THINGS CODEX MUST NOT DO

- Do not build every phase at once.
- Do not invent a fake Square implementation.
- Do not require Square credentials before Phase 11.
- Do not make Wayne's marketing calls synchronous inside checkout.
- Do not make address the customer primary key.
- Do not treat order phone number as permanent marketing permission.
- Do not let Hanafy calculate Wayne's authoritative lifetime spend independently.
- Do not delete/replace the Hanafy Campaign Manager.
- Do not let duplicate integration events double-send messages.
- Do not hard-delete menu items/orders to simplify UI.
- Do not store raw card data.
- Do not build a giant generic Zapier clone for v1 Hanafy automations; trigger + conditions + timing + actions is enough.
- Do not mark payment hardware complete until tested on the physical Wayne's setup.
- Do not switch the live restaurant off its old POS until parallel-run/reconciliation succeeds.

---

# 38. DEFINITION OF DONE FOR REPLACING THE EXISTING POS

The project is not production replacement-ready until all of the following are true:

- Wayne's controls production domain/DNS/accounts.
- Public online ordering is stable.
- Phone/walk-in POS is stable.
- Kitchen routing/KDS is stable.
- Orders survive refresh/reconnect.
- Printer failures are recoverable.
- Taxes/totals are verified.
- Square/live payment is stable on real hardware.
- Refund/void flows work.
- Cash drawer/shift close reconciles.
- Delivery workflow works.
- Staff roles/PINs/audit work.
- Customer metrics and segments recalculate correctly.
- Hanafy event outage cannot affect ordering.
- Marketing sends respect consent/STOP/suppression.
- Backups, logs, monitoring, and retry tools exist.
- Daily reports reconcile with payments/cash.
- Staff has successfully run the new system in parallel with the existing system.
- Ehab/owner signs off on operational workflow.

---

# 39. MASTER ACCEPTANCE SCENARIOS

A developer should be able to demo these scenarios before final go-live.

## Scenario A — online pickup
1. Owner adds new menu item with photo/modifiers.
2. Customer opens site on phone.
3. Selects pickup from first screen.
4. Adds item/modifiers.
5. Checks out.
6. Order saves once.
7. Order appears on KDS.
8. Order appears on admin calendar that day.
9. Staff marks ready/completed.
10. Customer profile metrics update.
11. Segment membership recalculates.
12. Relevant Hanafy events enter outbox asynchronously.

## Scenario B — phone delivery
1. Staff opens `/pos`.
2. Searches phone.
3. Existing customer/address loads or new customer is created.
4. Staff enters delivery order.
5. Kitchen receives ticket.
6. Order becomes ready.
7. Driver is assigned.
8. Driver marks pickup/delivery.
9. Cash/card status reconciles.
10. Customer history and reports update.

## Scenario C — 30-day win-back
1. Customer is eligible for 30-day inactive segment.
2. Nightly evaluator changes membership once.
3. `customer.segment.entered` enters Wayne's outbox.
4. Hanafy receives signed event once.
5. Published workflow matches.
6. Consent/suppression checks pass.
7. Win-back message is queued/sent.
8. Automation run explains why.
9. Duplicate event cannot duplicate send.
10. If customer later orders, Wayne's emits segment exit/update.

## Scenario D — weekly Text Club campaign
1. Manager opens Hanafy Campaign Manager.
2. Selects Wayne's Pizza.
3. Selects SMS-consented/Text Club audience or segment.
4. Writes weekly deal.
5. Test sends.
6. Reviews eligible/suppressed counts and cost estimate if supported.
7. Schedules/sends campaign.
8. Campaign history/results remain separate from automation history.

## Scenario E — Hanafy outage
1. Hanafy is unavailable.
2. Wayne's receives online and POS orders normally.
3. Orders go to kitchen normally.
4. Outbox events remain pending/retrying.
5. Hanafy returns.
6. Events deliver exactly once semantically.
7. Automations process without duplicate sends.

## Scenario F — payment provider interruption
1. Square terminal/provider temporarily fails.
2. Order/payment UI shows clear recoverable failure.
3. No order is falsely marked paid.
4. Retry/reconciliation works.
5. Webhook later produces correct final payment state.

---

# 40. FIRST PROMPT TO GIVE CODEX

Use this after placing this file in the repository, for example at `docs/WAYNES_POS_MASTER_BUILD_SHEET.md`:

> Read `docs/WAYNES_POS_MASTER_BUILD_SHEET.md` completely before making changes. Treat it as the product and architecture source of truth. Inspect the repository first. Do not attempt to build the entire POS. Implement **Phase 0 only** exactly as specified. Keep interfaces compatible with later phases, but do not prematurely implement later features. Use Next.js App Router, TypeScript, Tailwind, Supabase Postgres/Auth/Storage, committed SQL migrations, RLS, server-side authorization, validation, and a reusable responsive design system. Add tests for auth/role boundaries and migration integrity. Run build/typecheck/lint/tests. When finished, stop and give me: (1) what you built, (2) files changed, (3) migrations, (4) environment variables/setup I must complete, (5) exact manual test steps, (6) automated test results, (7) known limitations, and (8) whether every Phase 0 acceptance criterion passed. Do not begin Phase 1 until I explicitly approve it.

---

# 41. TEMPLATE PROMPT FOR EACH NEXT PHASE

> Read `docs/WAYNES_POS_MASTER_BUILD_SHEET.md` again and review the code produced by all previous phases. Implement **Phase X only**. Preserve all previous working functionality. Follow the detailed requirements and acceptance criteria in the master build sheet. Do not skip hard parts; if hardware/provider access is intentionally deferred by the spec, implement the correct adapter/interface and tests rather than fake production integration. Add migrations/types/server logic/UI/tests needed for this phase. Run build/typecheck/lint/tests. Then stop and report: files changed, database changes, setup/environment variables, manual test steps, automated test results, known limitations, and a requirement-by-requirement acceptance checklist. Do not start the next phase.

---

# 42. PROJECT PRIORITY ORDER

When tradeoffs are necessary, use this priority:

1. Never lose or duplicate an order.
2. Correct totals/payment/cash state.
3. Kitchen receives the correct ticket.
4. Staff can operate it quickly during a rush.
5. Historical data remains trustworthy.
6. Customer data/consent is handled correctly.
7. Integrations retry safely.
8. Reports reconcile.
9. Marketing automation works safely.
10. Visual polish / secondary convenience features.

That priority order should guide engineering decisions throughout the build.
