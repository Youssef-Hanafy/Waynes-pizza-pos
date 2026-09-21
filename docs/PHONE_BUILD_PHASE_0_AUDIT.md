# Phone-line build — Phase 0 repository audit

Build sheet: *Wayne's Pizza POS — Complete Build Sheet (website-first, Android-ready)*.
Audited 2026-09-20 against `main` at `0912833` and the live Supabase project
`vxpkdmtornkeoedkawkt` (27 migrations applied, in sync with the repo).

## What already exists (reuse, do not rebuild)

| Area | Where | State |
| --- | --- | --- |
| Auth / roles | `src/lib/auth/*`, `wayne_my_access()`, `wayne_has_permission()` | Working. Roles owner / manager / cashier / kitchen / driver / marketing_readonly. Permissions are rows, checked in SQL. |
| POS page | `/pos` → `src/app/pos/pos-client.tsx` | One screen: order type + customer column, menu grid, ticket. Fits the viewport (Phase 16). |
| Ordering | `wayne_create_pos_order(jsonb)` | Server re-prices everything, idempotency key, per-size modifier prices, included toppings, promos, manager discounts. Sources `pos` / `phone`, pickup / delivery. |
| Menu | `wayne_pos_menu()` | All from the database; nothing hard-coded. Categories, items, sizes, modifier groups, required/optional, availability, POS visibility. |
| Customers | `customers` (unique `phone_normalized`), `customer_addresses` | Lookup by name / phone / order # (`wayne_pos_customer_search`). Customer is created or updated when a phone order is submitted. |
| Phone normalization | `wayne_normalize_phone()` → `+1XXXXXXXXXX` | Matches the build sheet's normalization rule. |
| Caller ID (Phase 16) | `phone_calls`, `store_phone_lines`, `wayne_record_phone_call`, `wayne_phone_line_board`, `POST /api/phone/calls`, `scripts/callerid-bridge.mjs`, `phone-panel.tsx` | Line 1 / Line 2 tiles inside the order column. **Polls every 3 s**, no call status, no claim, no dismiss, no recent-calls list, no link from call to order. |
| Open orders / hand-off | `open-orders-panel.tsx`, `wayne_pos_open_orders` | Working; drawer-style modal, card reader + cash. |
| Cash drawer (shift) | `drawer-panel.tsx`, `/api/pos/drawer` | Working; counts cash, not hardware kick. |
| Payments | `src/lib/payments/provider.ts` (server `PaymentProvider`, Square) | Server-side interface already isolated. |
| Printing | `print_jobs` queue + `PrinterAdapter` interface (server) | Queue works; no physical printer adapter (models unknown — correct per sheet §2.7). |
| Realtime | `AutoRefresh` subscribes to `kitchen_tickets` | Pattern exists: RLS select policy + `supabase_realtime` publication. |

## Gaps against the build sheet (what Phases 1–5 must add)

1. **POS shell (§6)** — no section navigation (New Order / Phone / Orders / Customers / Delivery / Register / Admin) and no `PHONE (n)` badge. A call can only be seen if the cashier is already on the Phone order-type.
2. **Drafts (§13, §36, test 15)** — the ticket lives in React state only. Refresh loses it, there is no hold / resume, and only one ticket can exist. Taking a Line 2 call while Line 1's order is open is impossible without destroying it.
3. **Phone context on the order (§11)** — orders have no `phone_line` or caller-event link.
4. **Call lifecycle (§15, §32, §34)** — `phone_calls` has no status (`incoming / selected / order_started / dismissed / expired`), no claim (who is taking it, which register), no `order_id`.
5. **No polling (§20, rule 17)** — the phone panel polls every 3 s. Replace with an event bus fed by providers, plus Supabase Realtime for other terminals.
6. **Hardware abstraction (§4, §5)** — no `CallerIdProvider`, `PrinterProvider`, `CashDrawerProvider`, `PaymentTerminalProvider`, no client event bus, no simulator (§18), no `/admin/hardware` (§28).
7. **Customer matching (§33)** — `phone_normalized` is unique, so the ">1 match → choose" case cannot happen and a customer cannot have a second number (§14 "one or more phone numbers"). Needs an additional-numbers table.
8. **Customers section (§14)** — no POS customer screen with order history; lookup only exists inside the order column.

## Things noticed that are broken or risky

* `wayne_pos_customer_search` still returns **removed (erased) customers**. The admin list was fixed in `hide_removed_customers`; the POS search was not. Fixed in this build.
* `parseWhozzCallingRecord` (Phase 16) was written from memory of the Whozz Calling format, not from CallerID.com's official Ethernet Link documentation. Per the build sheet rule 4 it must be checked against the official manual before the Android phase relies on it. It is left untouched here; the website stage does not depend on it.
* Phase 15 (bundle deals, commit `b7c9c34`) is **not on `main`** — that patch was never applied. Not part of this build; flagged so it is not forgotten.
* `phone_calls` has 0 rows in production, so extending it is safe.

## Decisions

* **Reuse `phone_calls` as the build sheet's `caller_events`** (rule 10: no second system). It gains the status, claim, order link, dedupe key and device fields the sheet lists.
* **Drafts are local to the terminal** (localStorage) in Phase 2, keyed by an idempotency key so a retried submit can never create two orders. Server-side draft sync is Phase 6.
* **Claims are server-side now** (cheap and needed for "TAKING ORDER — Register 1"). Multi-terminal realtime hardening stays in Phase 6.
* **Browser never opens UDP** (§19). Simulated provider today; the Phase 16 HTTP bridge feeds the cloud provider; Android provider later.
* No Android, Capacitor, printer protocol or processor code is written.
