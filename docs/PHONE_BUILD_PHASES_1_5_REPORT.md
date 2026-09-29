# Phone-line build — Phases 0–5 completion report

Build sheet: *Wayne's Pizza POS — Complete Build Sheet* (website-first, Android-ready).
Phase 0 audit: `docs/PHONE_BUILD_PHASE_0_AUDIT.md`.

## What was built

### Phase 1 — POS shell (§6)
* `/pos` is now a tablet-first shell: header **WAYNE'S PIZZA · ☎ PHONE (n) · Register · staff · Admin**
  and sections **New Order · Phone · Orders · Customers · Deliveries · More**.
* Sections switch in place, so the ticket, the phone state and the hardware connection survive moving around.
* A ringing line pulses the PHONE button and the Phone tab. **It never pulls the cashier off the order they are entering.**
* Every control is at least 44 px (touch).

### Phase 2 — Core ordering (§10–13, §36)
* Every ticket is a **draft** saved on the register (survives refresh / closed tab).
* **Hold ticket** puts it on the hold tray and starts a fresh one; tap a held ticket to resume. Starting an order from a second call never destroys the first.
* Each draft keeps its own idempotency key, so a submit that fails (or is pressed twice) can never make two orders. If the connection drops, the ticket stays and says "Not sent".
* Phone orders carry `source = phone`, `phone_line` and the caller event into the order (`orders.phone_line`, `orders.phone_call_id`).
* New: **phone order without a profile** (pickup only), as the sheet's "Start order without profile" needs.
* Menu, modifiers, totals, taxes, promo/discount rules are the existing ones — unchanged, still database-driven.

### Phase 3 — Customer system (§14, §33)
* **Customers** section: search by phone, name, street address, email, customer ID or order #; detail with numbers, addresses, stats (orders, lifetime, average, last order) and order history; **New customer**, **Edit**, **Start order**.
* Customers can have **more than one phone number** (`customer_phones`). A number shared by two customers shows a **choose-the-customer** screen instead of guessing.
* Caller ID never creates a customer by itself — only a person pressing *Create customer* does.
* Fixed: the POS search was still returning **erased** customers.

### Phase 4 — Phone UI + simulator (§7–9, §15–18, §32–35)
* **Phone** section: Line 1 and Line 2 cards, never merged. INCOMING / AVAILABLE / *Answered — Register 1* / *Taking order — Register 1*.
* A ring shows **immediately** with the number ("Looking up customer…"), then fills in the customer when the database answers (§55).
* Line detail: existing customer (address, previous orders, last order, average, recent orders) → **Start phone order**; new caller → **Create customer + start order** / **Start order without profile**; **Dismiss**.
* Opening a line **claims** it for this register; another register sees who has it and must choose *Take over*. Two registers cannot unknowingly start two orders from one ring (§22).
* **Recent calls** (last 12 h) with outcome or order number; dismissed / missed calls can be **reopened**.
* Unanswered cards expire after the configured minutes (Admin → Hardware, default 10).
* Repeated packets are dropped; a customer who hangs up and calls back is a new card (§17).
* Placing the order links the call to it and clears the line (§34.9).
* **Simulator**: POS → Phone → *Test calls*, POS → More, and Admin → Hardware → *Test Line 1 / Test Line 2*. It runs through the same provider → event bus → phone store path real hardware will.
* **No polling.** The old 3-second poll is gone: rings from this register appear instantly; rings from the store bridge or other registers arrive through Supabase Realtime.

### Phase 5 — Hardware abstraction (§4, §5, §23–25, §28)
* `src/hardware/`: `CallerIdProvider` (Simulated, Cloud, Android slot), `PrinterProvider`, `CashDrawerProvider`, `PaymentTerminalProvider` (ManualExternalTerminalProvider), and the **hardware event bus**. `src/hardware/runtime.ts` is the only file that chooses implementations.
* Stores: `src/stores/phone-store.ts`, `order-store.ts`, `hardware-store.ts`.
* **Admin → Hardware** (`/admin/hardware`, owner only): caller ID provider, device, lines, UDP port (3520), bind address, optional box IP, card expiry, simulator switch; receipt / kitchen printer details and kitchen category routing; cash drawer connection; payment terminal status. Every save is audited.
* Printers, drawer and terminal report **Not configured** honestly — nothing ever claims a print or a charge that did not happen.
* The Android provider only defines the contract (`window.WaynesNativeHardware.callerId`). No Android, Capacitor, UDP, packet parser or printer protocol code was written (§19, §43 rules 3–6).

## Database — `20260921080000_phone_workflow_hardware.sql`
* `phone_calls` gains `event_key` (dedupe), `status`, `device_id`, `simulated`, `match_count`, `surfaced_at`, `selected_at`, `dismissed_at`, `completed_at`, `claimed_by`, `claimed_terminal`, `claimed_at`, `order_id`. Readable by POS staff (RLS) and published to Realtime; the anon key still sees nothing.
* `orders.phone_line`, `orders.phone_call_id`.
* `customer_phones`, `pos_hardware_settings` (+ `hardware.manage` permission, owner).
* Functions: `wayne_phone_board`, `wayne_phone_call_action`, `wayne_pos_record_call`, `wayne_pos_customer_orders`, `wayne_pos_save_customer`, `wayne_pos_hardware_settings`, `wayne_update_hardware_settings`; `wayne_record_phone_call` now deduplicates; `wayne_pos_customer_search` rewritten; `wayne_create_pos_order` patched in place to carry the call and allow profile-less phone pickups.
* The Phase 16 board function and `/api/phone/calls` bridge ingest are kept, so the store bridge keeps working.

## Tests
* `tests/phone-workflow.test.ts` (full migration chain, PGlite): 10/10 — simulated Line 1/Line 2, duplicates, multiple matches, claim lock, dismiss/reopen, order ↔ call link, profile-less pickup, RLS, owner-only hardware settings, search.
* `src/lib/phone/phone-state.test.ts` 8/8, `src/lib/orders/drafts.test.ts` 7/7, `src/hardware/hardware.test.ts` 4/4, `src/lib/phone/normalize.test.ts` 3/3.
* Every existing database test still passes (phases 0–9, 16, 0–8 remediation, all migration-integrity suites).
* `tsc --noEmit` and `eslint . --max-warnings=0`: clean.
* **Not run here:** `vitest` as a whole and `next build` — this repo's `node_modules` are macOS binaries. Run `npm run verify` on the Mac.
* `e2e/phase0-5.spec.ts` updated for the renamed *Phone order* button.

## Environment
* Optional `CALLER_ID_PROVIDER` / `CALLER_LINE_COUNT` override Admin → Hardware for a dev/test deployment.
* `CALLER_ID_INGEST_TOKEN` (Phase 16 bridge) is now documented in the `.env.*.example` files.

## Still to do (later phases)
* Phase 6: server-side draft sync across registers and full offline order queue.
* Phase 7: real printer provider once the printer models are known.
* Phase 8: the Android shell and the official CallerID.com parser (check `parseWhozzCallingRecord` against the official Ethernet Link manual before relying on it).
* Card-terminal **Mark paid** needs a server function to record an external-terminal payment; the provider already returns the "Run $X on the terminal" instruction.
