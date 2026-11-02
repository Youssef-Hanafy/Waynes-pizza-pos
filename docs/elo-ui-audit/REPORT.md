# Wayne’s POS UI and screen stability audit

Audit date: November 1, 2026 (America/New_York). Base: freshly fetched production `origin/main`, `086c5d6d5cab465afdaf078373e3a1af45343400`. Work branch: `codex/elo-ui-stability-audit`. No deployment or merge performed.

## 1. Overall UI health

**Production baseline: FAIL. Physical Elo acceptance: NOT VERIFIED.** Reproduced keyboard obstruction, caller-triggered navigation that dismisses a driver dialog, deployment-status layout movement, and undersized touch controls. These defects can explain reports of an unreliable or changing screen without an obsolete design actually loading.

The branch fixes the reproduced defects. Passing Chromium checks establishes only the tested software behavior. It does not establish that the installed APK, Android WebView, device density, fonts, hardware keyboard, card reader, or sleep/wake behavior matches this computer.

Production was inspected read-only: `/pos` redirects to `/login?next=%2Fpos`. The public `/api/version` reported commit `086c5d6` and build `dpl_9tWgkv2NFuWcaYuBNF8ZA7BFRRnt`. The downloaded production worker and repository worker have identical SHA-256 `21d39c08ce883b6a7efcd83a52d429e2792f33cd3e3c5afdedeb4615a08d1f06`. See `production-version.json` and `production-pos-headers.txt`. Authentication was not bypassed.

## 2. Screen switching

**Can the old screen still appear? Yes, on an already running old document, an unupdated/previously offline WebView, an old app session, or a deliberately opened historical deployment. The installed Elo state is unknown.** A newly controlled navigation using worker 5 does not substitute cached POS HTML. No alternate legacy register implementation or legacy stylesheet was found on current normal application routes. These facts do not prove that an old APK/session has already received worker 5.

**Can appearance still change? Yes.** Responsive breakpoints, keyboard space, caller banners, loss-of-network notices, data refreshes and intentional navigation remain. These must not be confused with deployment rollback. Explicit refresh/restart loads the current server or connection-recovery page. A cashier-approved version update still reloads once safety checks pass.

| Mechanism inspected | Finding / disposition |
|---|---|
| Startup/server page | `src/app/pos/page.tsx` is force-dynamic and renders one `PosApp` behind `OneTab`. Production POS HTML is no-store. Initial server page/SSR/hydration in an authenticated production session remains NOT VERIFIED. |
| Worker installation/activation/control | `public/pos-sw.js`, worker 5: skipWaiting, removes only named disposable Wayne frontend caches, claims clients. Controller changes ask for identity; they do not reload the register. Tested twice. Activation cannot replace JavaScript already executing in an old page. |
| Cached documents/static resources | Worker 5 never reads a cached frontend response. Network navigations use no-store. Legacy-cache migration and offline restart tests preserve operational markers. Hashed static assets may remain normally cached; they are referenced by the loaded deployment. Actual installed WebView cache state is NOT VERIFIED. |
| Android caching / old APK | Current native source uses `LOAD_NO_CACHE`; APK 1.5.2/code 8 contains that change. Older installed versions may not. No installed APK/version was observed. NOT VERIFIED on Elo. |
| In-place sections/remounting | `PosApp` owns the section state. Sections are conditionally mounted; switching away intentionally unmounts `OrderScreen` and resets its local category/search/dialog state. No alternate design is selected. Existing ticket-closeout-on-leaving behavior is business logic and was preserved. |
| Automatic version refresh | Baseline: update manager automatically reloaded a safe idle register after a deployment settled. **Fixed for register:** discovery waits for explicit operator approval of that exact build. Background polling/data refresh still works. Customer display keeps its existing idle update behavior. |
| Deployment synchronization | Existing release identity, high-water guard, preflight, final safety revision checks, two-attempt bounds, settle window and hourly cap retained. Simulated A→B→C, rapid releases, slow responses and stalled 204 navigations passed twice. No new production deployment was made. |
| Caller-ID navigation | Baseline auto pickup could unmount Deliveries while its driver clock dialog was open. **Fixed:** no automatic pickup with a dialog, focused editable field, or hidden document. Idle pickup remains enabled; deferred calls stay visible in the ringing UI. |
| Status/layout shift on update | Baseline update badge grew the header from 60 to 112 CSS px at 1280×720. **Fixed:** status occupies reserved space within the existing header. Before/after measurements and screenshots included. |
| Browser restoration / back-forward cache | `pageshow.persisted` resumes a stalled update manager and checks safety; it does not itself reload. Synthetic pageshow/reconnect/visibility events preserved the document. Real browser eviction/restoration on Android is NOT VERIFIED. |
| Connectivity loss/recovery | Running UI retains its loaded document; reconnect probes and refreshes data, not RSC/router navigation. A fresh offline navigation intentionally shows worker recovery and retries every 10 seconds. Network-only loading cannot promise offline cold startup. Tested twice with the real worker. |
| Background/foreground | No native `onResume` reload exists in current source. Hidden documents block version updates and now auto pickup. Synthetic lifecycle events passed. Android task switching and process suspension are NOT VERIFIED. |
| Sleep/wake / system bars | Current native activity keeps the screen on and applies system/cutout/IME insets. Actual device sleep, power, Android bar sizes and keyboard insets require hardware. NOT VERIFIED. |
| Multiple tabs/sessions | Exclusive Web Lock waits without stealing the register; opening a second tab and closing the first transfers ownership. Tested twice. Separate browsers/profiles/apps are separate lock/storage domains. Unsupported WebView Locks API produces “Browser update required”; actual device API support is unknown. |
| CSS/font failures | One global stylesheet, current Tailwind pipeline flattens cascade layers; no legacy CSS fallback. Fonts use next/font swap. Missing CSS can still make first paint unstyled before client error handlers exist; an asset failure may need an operator update. Hosted font metrics, old-WebView CSS support and genuine CSS-loss startup were NOT VERIFIED. |
| Hydration | Actual Next production compilation passed; isolated render harness mounts client components and does not exercise SSR hydration. No browser errors in the viewport interaction cases. This is not proof of absence of hydration faults in authenticated production. |
| Native process recovery | Current Activity starts the production URL on recreation, never restores saved WebView state. There is no `onRenderProcessGone` recovery handler. A renderer crash/frozen WebView and restoring the exact prior section are NOT VERIFIED. Do not clear app data to investigate. |
| Explicit navigation | Admin and Customer screen links intentionally leave the register. Paid card summary advances after five seconds by existing design. These are different from obsolete interface switching. No functionality was removed. |

## 3. Screen size and buttons

Tested CSS viewport candidates: **1920×1080/DPR 1, 1280×720/DPR 1.5, 1024×600/DPR 1, 960×540/DPR 2, 800×600/DPR 1, 768×500/DPR 1, 767×600/DPR 1, 1280×400/DPR 1**. They are not claimed to be the Elo’s measured settings. Physical panel size/resolution alone cannot determine Android CSS viewport/density.

Existing 768/1024/1280/1536 breakpoints and fit-to-space behavior explain different appearances. The current-orders rail is deliberately hidden below 1024px; menu tile column counts respond to available area. Narrow navigation scrolls horizontally. The menu/ticket have separate vertical scrolling regions. No page-wide horizontal overflow was observed in the tested register cases. Small viewports still need scrolling; they are not required to display all menu entries at once.

Ticket −/+ and remove controls now remain at 44×44 CSS pixels; ticket rows scroll rather than scaling below that size. Categories, Specials, Open item and Discount have a 44px minimum height. Modifier +/- columns are 4rem, yielding at least 44.8px at their existing 0.7 minimum scale; size and ingredient/half selection controls have a 4rem minimum height for the same reason. Modifier names wrap rather than truncate. Secondary controls elsewhere can still be smaller than 44px (for example the rail fold control); this audit does not certify every control on unvisited administrative screens.

POS fixed dialogs now subtract the custom keyboard height and, when applicable, caller-banner space. Their existing scrolling bodies stay available. Native Android keyboard, accessibility font scaling, browser zoom, old WebView viewport behavior, status/navigation bars and the exact installed Elo density remain NOT VERIFIED.

## 4. Confirmed bugs, ranked by business impact

| Severity | Defect, source and underlying cause | Reproduction / Elo relevance | Fix and evidence |
|---|---|---|---|
| CRITICAL (stability requirement) | An idle register reloads automatically just because a release is available. `src/app/pos/pos-app.tsx` supplied only idle safety to `useAppUpdate`. | Existing real-worker tests demonstrate automatic idle version changes. This behavior applies to the Elo when that web code is loaded. It is not evidence of a reload during an active ticket. | Register approval is now required and bound to the exact target build. Full-register test holds one document for ten simulated minutes, rejects superseded approval, then observes only the explicitly approved reload. |
| HIGH | Item notes keyboard covers notes/add button. `src/app/globals.css`, fixed overlays under `src/app/pos/item-dialog.tsx`: shell padding cannot constrain a fixed overlay. | 1280×720 → menu → item → tap Item notes. Keyboard top y=433; Add button y=558, height 56. Elo’s Wayne keyboard uses this path. | Scoped overlay bottom/max-height accounts for keyboard, with vh fallback and dvh support plus caller offset. `before-keyboard.png` versus `after-keyboard-run1.png`; single touch Add succeeds. |
| HIGH | A ringing call dismisses driver clock dialog. `src/app/pos/pos-app.tsx` classified the entire Delivery section as idle. | Deliveries → Driver clock in/out → incoming ring. Before-fix regression fails because Deliveries loses current-page state and the dialog unmounts. Same subscription runs on Elo. | Focus/dialog/visibility guard; `before-caller-log.txt` records failure, final regression retains dialog. Separate positive regression preserves idle caller pickup. |
| HIGH | Release detection moves all controls below the header by 52px. `src/app/pos/pos-app.tsx` inserted an extra flex child which wrapped the header. | At 1280×720 detect a new build. Header changes 60→112px without resizing or navigation. Depends on Elo’s effective width. | Reserved status space inside header: 60→60px. `before-update-banner.png`, `after-update-banner.png`, `header-measurements.txt`, and rectangle regression. |
| HIGH | Ticket controls are too small and get smaller as the order grows. `src/app/pos/order-screen.tsx`: 36×40px quantity buttons, 32×40px remove button and ticket zoom floor 0.7. | Add an item; inspect/tap +/- at candidate tablet viewports, especially short available height. Recorded baseline quantity boxes include 36×40 and a scaled 33.47×37.19. | 44×44 buttons, no ticket downscaling, existing list scrolling retained. Viewport regressions check physical bounding rectangles and successful touch quantity updates. |
| HIGH | Caller banner leaves PIN dialog Cancel partially clipped. `src/app/globals.css`: the max-height-constrained plain dialog div did not scroll its own contents. | Deliveries → Driver clock → incoming ring at 1280×720; Cancel extends below the window. This shares the Elo caller/PIN layout. | Plain dialog div now scrolls within its constrained height. Regression scrolls Cancel fully into view and dismisses with one touch; `driver-ring-run1.png`. |
| MEDIUM | Modifier names clip; modifier/size controls shrink below reliable touch size. `src/app/pos/item-dialog.tsx` used truncate, 3.25rem control columns and 48px size buttons inside a min-0.7 panel. Category controls were only 36px high in `order-screen.tsx`. | Open representative multi-group dinner; labels such as French Fries/Extra Cheese truncate. Size selector in keyboard screenshot scales to about 34px. Relevant whenever Elo fit scaling runs. | Wrapped names, 4rem modifier columns and relevant selection heights; category controls 44px. Final dinner screenshot and measured modifier touch regression. |

No confirmed Stripe, tax, pricing, driver-tip, printing, delivery-calculation, authorization or database defect was altered.

## 5. Fixes implemented

Only four application components and global rendering CSS changed: `pos-app.tsx`, `app-info-panel.tsx`, `order-screen.tsx`, `item-dialog.tsx`, `globals.css`. Added the isolated UI harness, browser regressions, npm test command and CI execution/artifact capture. No native source, service worker, update manager, financial handler, schema, API route or database data was changed. Existing storage and offline order synchronization remain in place.

The register deliberately waits for operator approval now. Staff should use **More → This app → Update when register is idle**, finish all work and leave it untouched for at least 60 seconds. All existing pending-work, payment, printer, tip, focus, dialog, background and network safety checks must still pass. If a different build appears, approval must be given again.

## 6. Before/after evidence

- `before-keyboard.png` / `after-keyboard-run1.png`: obscured versus usable item notes/footer.
- `before-update-banner.png` / `after-update-banner.png`: deployment badge reflow versus stable header.
- `before-menu-1280x720.png` / `after-menu-1280x720-run1.png`: same interface, enlarged touch controls (after-image DPR 1.5; compare CSS geometry, not raw pixel dimensions).
- `dinner-modifiers-run1.png`: representative modifier groups with wrap and touch sizing.
- `driver-ring-run1.png`: ringing banner with driver dialog retained.
- `customer-lookup-run1.png`: synthetic customer search and detail, without a save.
- `cash-selection-run1.png`: synthetic unpaid order opened in payment UI; no charge submitted.
- `screens-overview.png` and `screen-*.png`: major sections; synthetic empty/list states, not store screenshots.
- `before-measurements.txt`, `header-measurements.txt`, `before-caller-log.txt`, `ui-log.txt`, `ui-results.json`, `stability-log.txt`, `final-verification.txt`: source measurements and execution evidence.

The initial before-menu image includes an “Orders unavailable” notice caused by the exploratory generic API stub; that notice is not a production finding or a claimed fix. The corresponding final harness uses schema-shaped fixture responses. Compare the relevant control geometry, not these synthetic status messages.

The render harness imports real components/stores and real global CSS processed by the application’s Tailwind/cascade flattening pipeline. It uses system font fallback rather than hosted next/font assets. It is **not** an authenticated Next.js page, real Android application, database integration or Vercel deployment test.

## 7. Test results

**Software checks: lint PASS; TypeScript PASS; unit suite 970 passed, 4 skipped (144 files passed, 1 skipped); production build PASS.** See `final-verification.txt`.

**Chromium: the full 17-case register suite passed twice (34/34) in 3.5 minutes**, including both slow-rendering cases; `full-ui-log.txt`. After final modifier-width and PIN scrolling refinements, **32/32 non-throttled cases passed** (16 cases repeated twice); final results are in `ui-log.txt` and `ui-results.json`. A supplementary representative customer search/detail test was also run twice (`customer-lookup-log.txt`), without saving a record. The supplemental customer lookup passed 2/2. The slow test had already passed twice and those refinements do not change its ticket-position or network behavior. The full-register suite runs every case twice, including eight viewports, touch quantity changes, item notes keyboard, 24 section transitions per navigation case, Back, repeated refresh, offline/online events, pageshow/visibility events, exclusive tab ownership, caller dialog protection, ten simulated idle minutes across releases, operator-target approval, rich modifiers/dialog dismissal, and opening a synthetic existing order/payment selection. The slow-rendering test uses Chromium CPU slowdown ×4, 300ms latency and 150,000-byte/s download throughput; it repeats five dialog cycles and three refreshes and compares ticket control rectangles.

The separate seven-case real-worker suite ran twice: **14 passed, zero failed**, in 3.9 minutes. It covers actual service-worker navigation/cache migration and real update-manager logic against simulated releases, including a 12-second document delay and temporary server failure. Its minimal HTML fixture does not prove register visual correctness; the new full-register suite supplies that distinct coverage.

Exploratory runs are not hidden: harness startup initially needed a browser process shim; one test used an incorrect Back accessible name; simultaneous suites initially collided in Playwright’s shared trace directory; a positive caller test incorrectly matched “Phone” instead of “Phone (1)”; a throttled 3.3MB unminified harness exceeded a 45-second whole-test budget. The final sizing regression also caught the parent border reducing modifier button height to 42.8px at 0.7 scale; minimum height was moved onto the buttons themselves and retested. The output directories, selectors and slow-test budget were corrected. These were harness failures, not silently counted as successful UX evidence. An intermediate run was interrupted after adding the confirmed header fix; final verification uses a freshly compiled fixture. `exploratory-ui-log.txt` and `intermediate-ui-log.txt` preserve the later exploratory executions.

Not exercised: physical screen-off/on, actual Android app switching/process kill/renderer crash, native keyboard inset behavior, real WebView zoom/text scaling/runtime API compatibility (including AbortSignal.timeout and Web Locks), hours-long wall-clock store use, true browser BFCache eviction/restoration, authenticated SSR/hydration, real CSS/font loading failures, real kitchen/printing/payment execution, or a new production deployment. Synthetic lifecycle events and fake elapsed time are explicitly not equivalent to these conditions. Four existing unit tests are skipped by the repository suite; see the verification log.

## 8. Elo hardware status

**NOT VERIFIED.** No physical Elo or connected Android bridge was available. No app data, localStorage, IndexedDB, production order or customer was cleared or modified.

These branch changes are web UI changes and do not require a newly built APK by themselves. The **previous** native `LOAD_NO_CACHE` fix does require **APK 1.5.2/code 8** if the Elo has an earlier APK. Its installation cannot be inferred from the deployed website. Update in place with the existing package identity and signing key; do not uninstall or clear storage. The Android WebView version and effective viewport/DPR must be read on the physical register; the 15.6-inch specification does not answer that.

## 9. Release readiness

Ready for review and controlled hardware acceptance only after final software checks pass. **Not a declaration that the store problem is solved.** No automatic production release is authorized or performed. Existing web sessions must load the newly released code before its protections can apply; the old running client cannot retroactively receive the new approval guard.

Minimum physical acceptance, during a quiet period and without real charges or changing real orders:

1. Read More → This app: installed APK/version code, WebView, website build/commit and worker. Record effective viewport, DPR and Android text/display scaling. Establish whether code 8 is installed before attributing native cache behavior to it.
2. In an isolated representative environment on the Elo, take a test ticket through category/item/modifier/quantity, customer lookup, delivery/pickup and payment selection. Verify notes and footer remain tappable with keyboard and ringing caller banner together. Do not press a real charge/Record cash action.
3. Ring a caller while the driver clock dialog is open: dialog and entered PIN stay. Ring while truly idle: existing auto pickup still works.
4. Briefly disconnect/reconnect Wi-Fi while entering a test ticket; background/foreground and sleep/wake it. Confirm the loaded screen does not navigate or reload and the ticket remains. Then test explicit refresh and app reopening separately; distinguish reconstructed register startup from foregrounding a live process.
5. Make one controlled test deployment. With the old loaded page idle for at least five minutes, confirm no spontaneous reload. Choose Update on the exact offered build, finish all work and wait safely idle; confirm one update and matching loaded/server builds. Reopen/refresh several times and verify no legacy screen returns.

## 10. Exact next action

**At the store, open More → This app on the physical Elo and record the APK version/code, WebView and website build before changing anything.** Then run the quiet-period acceptance above against the reviewed branch’s isolated preview. If the installed APK is below code 8, perform the existing signed in-place update before judging native cache recovery. Authorize production promotion only after the physical results have been recorded; do not report the interface-switching problem resolved until then.
