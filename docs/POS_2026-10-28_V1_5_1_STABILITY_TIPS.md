# v1.5.1 — tips that never disappear, no more old screens (2026-10-28)

Owner: after the 1.5 upgrade "functionality we corrected in v1.4 is reverting",
and "he enters tip amounts … exits … when returning to close out the tips, the
amounts he previously entered are missing."

## A. Root cause

### Tips disappearing (confirmed in the code and the live data)

* A tip typed in **POS → Tips** or **Deliveries → cash-out** was kept only in that
  screen's React state (`useState` in `tips-screen.tsx` / `deliveries-screen.tsx`)
  until **Charge** / **Cash out** was pressed. Nothing was written to the tablet
  or to Supabase before that.
* Anything that closes the screen erased it: switching tabs (screens are unmounted,
  not hidden), a ringing line auto-opening the Phone screen *from Deliveries*
  (`pos-app.tsx` counts Deliveries as "idle"), the "View" button on an online-order
  alert, and any page reload.
* The POS reloads itself more than it looks: the 3-minute background refresh
  (`router.refresh()`) turns into a **full page reload** whenever it can't finish:
  a moment without internet, a server error, or a new deploy going live
  (Next.js `fetch-server-response.js` → `doMpaNavigation`). It did that whatever
  was on screen.
* Live evidence (pos_device_events / order_events, 2026-10-27): the Elo reloaded 4
  times between 9:13 and 9:26 pm (same build, so not a deploy), then at 10:05 pm
  the driver cash-out charged 5 held delivery cards and **3 went through with a $0
  tip** (#12, #13, #16). Their slips need checking by hand.
* Not a v1.5 code change: the tips have been memory-only since 2026-10-13. v1.5
  made it worse: more reloads (an offline register reloads into its saved copy).

### Old functionality coming back (confirmed mechanism)

* The Android app (1.4 or 1.5) is only a WebView of `app.hanafymedia.com/pos`:
  every screen is the website. One package (`com.waynespizza.pos`), debug key, so
  there are no two apps fighting. The 1.5 APK's own changes are only the Stripe
  offline reader. Device log: the Elo moved from app 1.4 to 1.5 on 2026-10-26, and
  every page open since then reports the current Vercel build.
* 1.5 added `public/pos-sw.js`, which keeps "the last good copy" of the POS page
  and opens it when the server can't be reached within 10 s. After a deploy, that
  copy is the **previous build** until the POS is next opened online.
* Combine that with the reload above. A blip during the 3-minute refresh reloads
  the page, the page opens from the saved copy (**the old build**), and a minute
  later the update checker sees the server is newer and reloads again (only when
  idle on New Order). The screen switches between old and new.
* Also checked, not the cause: Vercel `/api/version` (static per deploy, no-store);
  POS HTML is `force-dynamic` (no HTTP caching); `clearCache` on APK update; the
  drafts key `pos-drafts.v2`; git history (linear, no reverted commits; see C).

## B. Changes

| File | What |
|---|---|
| `supabase/migrations/20261113080000_tip_drafts.sql` (tested live in a rolled-back transaction; **apply before pushing**, see E) | `pos_tip_drafts` (one row per order) + `wayne_pos_tip_drafts()`, `wayne_pos_save_tip_drafts(jsonb)`, `wayne_pos_clear_tip_drafts(uuid[])`. The newest edit wins (`client_updated_at`, capped at now+2 min). Rows are read back only while the order still waits for its tip. RLS on, no table grants. Rollback SQL is at the top of the file. **It never charges anything.** |
| `src/lib/tips/drafts.ts` (+ test) | Merge rules: newest wins, an older offline copy never overwrites, rows for charged orders are dropped, unsynced edits are kept. |
| `src/stores/tip-drafts.ts` | Each keystroke is written to the tablet right away, then sent to the server after 0.6 s. It retries on reconnect, every 30 s, and when the app is hidden or closed, and it pulls in other registers' values. |
| `src/app/api/pos/tip-drafts/route.ts` | GET / POST for the above. |
| `tips-screen.tsx`, `deliveries-screen.tsx`, `tip-saved-note.tsx` | The boxes read and write the saved store. Each box shows **Saved on this register · sending…**, **✓ Saved · not charged yet**, or **Not saved: …**. A banner says the tips are saved but not charged until Charge / Cash out. Tips are saved before charging. After a charge, only the orders actually charged are cleared, so a card that failed keeps its tip. The Tips list is cached for an offline restart. |
| `api/pos/tips/route.ts`, `api/pos/delivery/cashout/route.ts` | After a successful charge / cash-out, clear those orders' saved tips (best effort) and return which orders were charged. Capture and recording code is untouched. |
| `src/app/pos/pos-auto-refresh.tsx`, `page.tsx`, `pos-app.tsx` | The POS no longer uses the shared `<AutoRefresh>`. It refreshes only when idle (empty New Order, Today's Orders, Orders), only after a quick server check, never when the server runs a newer build, and never from the offline copy. |
| `public/pos-sw.js` | Stamps the saved copy with the time it was saved, and tells a page opened from it (`wayne-offline-copy` message). The cache names are unchanged, so the update keeps the offline copy. |
| `src/stores/app-build.ts`, `use-app-update.ts` | Current, live and offline-copy build state. First check after 3 s (was 15 s) and again on reconnect. A page opened from the offline copy reloads onto the real page once the server answers and the register is idle. The header warns while it runs from the copy. |
| `src/app/pos/app-info-panel.tsx` (More → **This app**) | Website build + commit + build time, what the server runs, opened from server or offline copy, Android app version/code/app id/signing key/install dates, WebView, offline worker version, tips waiting to save, register id. Includes a **Load the current version now** button. |
| `src/stores/order-store.ts` | Saved tickets a build can't read are copied to `…pos-drafts.v2.unreadable` before anything overwrites them. |
| `android/…/NativeBridge.java`, `build.gradle.kts` | App 1.5.1 (versionCode 7): `info()` adds versionCode, package, build type, signer fingerprint, install/update time and the WebView version. |
| `supabase/migrations/20261111080000_caller_id_popup_save_once.sql` | Replay fix only. A database built from the migrations has a comment line that the live function doesn't, so this migration failed on every fresh database. That broke **all** full-chain DB tests since 2026-10-27. No effect live (already applied). |
| `tests/tip-drafts.test.ts`, `tests/pos-offline-worker.test.ts` | New tests. |

## C. Version comparison

* APK 1.4 → 1.5: only `StripeReader.java` (offline reader), `NativeBridge.java`
  and the version. The screens are the website's, so "v1.4 behaviour" means the
  website as it was on 2026-10-20…24.
* Website changes since then (all intentional, kept): offline register (1596179),
  edit an order by tapping it (133166c), short kitchen slips / day numbers
  (5e1ca4e, a7abb66), caller ID pop-up (55c6bf6), save customer on start (202b026).
* Checked with a blame-based scan for lines from earlier fixes removed later. No
  commit since 2026-10-19 undoes another, with one note: **b6b66fb (Codex,
  2026-10-20)** changed the New Order card so tapping Walk-in / Pickup / Delivery
  only *selects* the type, and a separate button starts the order. That reverses
  the 2026-10-13 rule (one tap starts the order). It is left as it is until the
  owner says which he wants.

## D. Tests

Run in the device VM. npm is blocked there, so: `tsc` and ESLint on the real
`node_modules`, and the vitest files under Node 22 type stripping with a small
vitest shim (the Mac's `npm test` is the real run).

| | Result |
|---|---|
| `tsc --noEmit` (whole repo) | ✅ clean |
| ESLint `--max-warnings=0` (changed files + `pos-sw.js`) | ✅ clean |
| `src/lib/tips/drafts.test.ts` (9) | ✅ all pass (scenarios 1, 2, 4, 6, 11 logic) |
| `tests/tip-drafts.test.ts` (6, full migration chain in PGlite) | ✅ all pass (newest wins, stale refused, captured orders hidden, never charges, permissions, clear) |
| `tests/pos-offline-worker.test.ts` (4) | ✅ all pass (server page always, saved copy only offline and flagged, 5xx never swapped, cache names kept) |
| `tests/migration-integrity`, `draft-sync-pilot`, `print-station` | ✅ pass (the last two failed on HEAD because of the 20261111 replay break) |
| All `src/**/*.test.ts` | same 29 shim-only failures before and after the change (`vi.fn().mockResolvedValue`, `it.each`, …), 0 new |
| Migration on **live** Supabase in a rolled-back transaction as the owner | ✅ save, stale refused, newer kept, future clock capped, −$1 refused, list, clear, table unreadable |

Needs the Elo (manual, see below): scenarios 2, 3, 5, 7, 8, 9 on the real tablet, plus the printer, drawer and M2.

## E. Release plan

0. Apply the migration first. Supabase → SQL Editor, paste `supabase/migrations/20261113080000_tip_drafts.sql`, press Run. It only adds a table and three functions. If the website goes live without it, tips are still saved on the tablet (shown as "sending…") but not on the server, until it is applied.
1. On the Mac: `git push origin main`. Vercel builds main, and the registers move onto it when idle.
2. On the Elo, POS → **More → This app**: *Website build* should equal *Server is on*, and *Opened from* should say the server ✓.
3. Tip test (no card charged): open **Tips** (or Deliveries with a driver's run), type a tip, go to New Order, come back. The tip is there, marked **✓ Saved · not charged yet**. Force-close the app and reopen it: still there. Turn the Elo's Wi-Fi/ethernet off, type a tip (*Saved on this register · sending…*), restart the app, turn the network back on: it changes to ✓ Saved.
4. APK 1.5.1 is optional: nothing in this fix needs it, it only adds detail to More → This app. If installing it, build it on **this same Mac** (debug key: Android Studio → Build → Generate APKs) and install it over 1.5. Never uninstall first (that wipes the register's saved tickets, tips and sign-in). More → This app should then show *1.5.1 (code 7)* with the same signing key as before.
5. Rollback: revert the commit and push (the website goes back; saved tips stay harmless in the table). DB rollback SQL is at the top of the migration.

## F. Prevention

* Everything typed that is money (tips) is saved durably as it is typed, with a visible saved / not-saved state.
* The POS never reloads itself mid-screen: background refreshes are idle-only, and deploy reloads were already idle-only.
* Every register shows its exact build, and the server's, on More → This app. The device log `pos.open` carries the same.
* The offline copy is labelled and replaced as soon as the server answers.
* Release check: after each deploy, More → This app on the Elo; `npm test` must pass (the DB chain tests run again now).
* Codex and Claude both push to main. Pull before working (`git pull --rebase`) so neither copy pushes an older version of a file over the other.
