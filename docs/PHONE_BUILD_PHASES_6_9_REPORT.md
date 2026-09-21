# Phone-line build: Phases 6–9 report

Build sheet: *Wayne's Pizza POS: Complete Build Sheet* (website-first, Android-ready). Phases 0–5: `docs/PHONE_BUILD_PHASES_1_5_REPORT.md`.
The sheet ends at Phase 9. Phase 6 is fully built. Phases 7–9 are prepared as far as they can be without the printer models, the Android build tools, and the store itself.

## Phase 6: Order sync and reliability (built)

* **Tickets are shared between registers.** Every ticket with something on it is saved to the server about 1.5 s after it changes (`pos_drafts`). A held ticket shows under **Other registers (n)** on every other register, with **Take over here**. Taking it over moves it and is recorded in the audit log.
* **No silent overwrites.** If a register comes back online holding a stale copy of a ticket someone else took over, it's told ("taken over by Register 2") and drops its copy. It never overwrites the new one.
* **Sending during a connection drop.** A submit that fails for lack of a connection keeps the ticket, marks it *waiting to send*, and resends it automatically when the connection returns. It uses the same idempotency key, so there's still exactly one order. A green notice says when it went through. A real refusal (sold out, bad address) isn't queued; the cashier fixes it.
* **Nothing is reported as sent until the server confirms it.** The header shows "*n* tickets waiting to send", and closing the tab while one is waiting asks first.
* **Sent tickets can't come back.** A ticket whose order already exists is closed server-side, even if the register never said so.
* **Realtime.** Registers learn about held or taken-over tickets through Supabase Realtime. Call claiming and call sync were done in Phase 4.

## Phase 7: Printer readiness (prepared, waiting on printer models)

* **Receipt and kitchen ticket layouts** (`src/lib/printing/document.ts`). The receipt shows the line, customer, address, items, "NO …" toppings, totals and payment state. The kitchen ticket is large type with no prices.
* **Category routing.** Admin → Hardware → *Categories that print in the kitchen* (e.g. Pizza → kitchen, Drinks → front). If none are chosen, everything goes, same as today's print queue.
* **Printing is chosen per printer in Admin → Hardware:** *Not chosen yet*, *This device's print dialog*, or *ESC/POS over the network*. ESC/POS is only used once someone picks it for a confirmed model; no protocol is assumed (§2.7).
  * Until a receipt printer is set up, receipts use the device's print dialog, sized for 80 mm or 58 mm paper.
  * ESC/POS network printing and the cash-drawer kick (through the receipt printer) go through the Android app. A browser can't open printer sockets.
* **Print receipt / Print kitchen ticket** buttons on the order-sent screen. **Test receipt printer / Test kitchen printer / Open cash drawer** on Admin → Hardware.
* **Failures are reported, never hidden.** No provider claims a print that didn't happen. The print dialog only reports that it opened.
* Kitchen tickets keep printing through the existing print queue in the meantime.

**Update: printers confirmed from photos.** Front: Epson TM-T20III L (thermal, Ethernet, cash drawer on its DK port). It prints receipts, every online order slip, and the tip & signature slip. Kitchen: Epson TM-U220B with a UB-E04 Ethernet card (impact). It prints kitchen tickets only. Both are ESC/POS on port 9100 and are pre-filled in Admin → Hardware, switched off until their IPs are entered. Automatic printing runs on the one register switched to **Print station**. Setup steps: **`docs/PRINTER_SETUP.md`**. Migrations `20260923080000_store_printers_print_station.sql` and `20260923090000_print_station_release.sql` (applied to live).

**Still needed from you:** the two printers' IP addresses (see PRINTER_SETUP.md §1).

## Phase 8: Native Android app (prepared, build on the Mac)

* `capacitor.config.json`, `native/android/…`: the shell (`MainActivity.kt`, screen kept on) and two plugins:
  * **`WaynesCallerIdPlugin.kt`**: UDP listener on the configured port (3520). Holds a Wi-Fi multicast lock and requests Android 17's `ACCESS_LOCAL_NETWORK` permission; a denial shows as *Local network permission unavailable*. It forwards each packet untouched.
  * **`WaynesPrinterPlugin.kt`**: sends already-encoded bytes to a printer's IP:port with a timeout.
* `src/hardware/native/bridge.ts` connects the plugins to the existing `AndroidCallerIdProvider` and printer providers. The phone screen and stores are unchanged (§62).
* **Parser checked against CallerID.com's official Ethernet Link manual.** Records are read from the 21st character, as the manual says, not from the first `$`, which it warns is unreliable. The manual's own example records are now unit tests. Detail records (ring / off-hook / on-hook) are ignored. The store bridge no longer strips bytes out of the header.
* Repeated packets keep one call id. A call-back after the box reports the call ended gets a new one (§17).
* Step-by-step build and install: **`docs/ANDROID_APP_SETUP.md`**. The Kotlin hasn't been compiled here (no Android SDK or Capacitor packages available), so expect small fixes the first time.

## Phase 9: Store pilot (prepared)

* **Admin → Pilot** (owner and manager): 30 checks taken from the build sheet — network validation (§57), real Line 1 and Line 2 calls, duplicates, reliability, orders, printing, cash and card, and a full day beside Thrive.
* Each check is Pass / Fail (N/A only for optional ones), with a note, who checked it and when, and an audit entry.
* **GO / NO-GO:** GO only when every required check has passed and nothing has failed. Thrive stays until then.

## Database: `20260922080000_draft_sync_printing_pilot.sql` (applied to live)

`pos_drafts` + `wayne_pos_sync_draft / open_drafts / take_draft / close_draft` (RLS, Realtime), `wayne_pos_print_document`, `pilot_checks` + `wayne_pilot_checklist / record_pilot_check`, new permission `pilot.manage` (owner, manager).

After it was applied, the whole flow was run on the live database inside a transaction that was then rolled back: save, conflict, take over, stale-copy refusal, order placed with the ticket's key, ticket auto-closed, print document, pilot result, and required-N/A refusal. All passed, and nothing was left behind. The only trace is one skipped order number (sequence numbers can't roll back).

## Tests written

* `tests/draft-sync-pilot.test.ts` (full migration chain)
* `src/lib/printing/document.test.ts`, `src/hardware/native/bridge.test.ts`, `src/lib/phone/whozz-parser.test.ts`, `src/lib/pilot/schemas.test.ts`, and new cases in `src/lib/orders/drafts.test.ts`

Run `npm run verify` on the Mac. It covers lint, typecheck, the tests above and `next build`.
