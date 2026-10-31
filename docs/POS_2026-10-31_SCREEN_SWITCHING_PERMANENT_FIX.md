# Elo old/new screen switching — root cause and permanent fix (2026-10-31)

Branch `claude/elo-screen-stability-v2`, based on production main `06170e7` (live as `dpl_DAAo98sXpBQpJu2hBn9a64W9jNKL`, verified from `/api/version`). No database migration, no Android/APK change, and no change to payments, tips, pricing, printing or offline-order code.

## What the production record shows

All of this comes from read-only queries of `pos_device_events`, `pos_drafts` and `print_jobs`, plus `/api/version`:

- **No code was reverted.** Main has every screen-stability change from `4ccaac0`. The delivery-tip and dinner-pricing merges did not touch the update code.
- **Three production deployments went live in six minutes:** `…3uZzA4` at 22:12Z, `…5NVkAH` at 22:13Z and `…W9jNKL` at 22:18Z.
- **The Elo (Register 1, APK 1.5) was on the old build the whole time.** It ran the 2026-10-30 build `…997TxV` from 22:12 to 22:20 while the server ran the new code.
- **After its update attempt, the Elo went silent.** Its last update log was at 22:20:46. It kept working until 23:07 (tickets, caller ID, printed slips) but wrote no further update or open logs.
- **No managed update has ever been confirmed.** In 30 days, no register logged `app.reload` or `app.update_confirmed`.
- **Order #17 at 22:21 came from the Mac.** It was device `8067ee27`, which is also named "Register 1". It was not the Elo.

## Root causes (each reproduced in a real browser before fixing)

1. **No settle window, and no reload cap across deployments.** Each new deployment got its own two-attempt budget. Back-to-back pushes therefore meant back-to-back screen changes (A→B→C→D).
2. **The offline worker could open an older build.** Whenever the server took more than 10 s, the worker served its saved copy, even if that copy was older than the build the register knew was live. The update reload, Android's "Can't reach the POS" retry and app restarts then opened the **old** screens. After two failed attempts the register was locked on the old build.
3. **"Departed" was a dead end.** If the update reload did not replace the page, the manager never checked again. That matches the Elo's 45 silent minutes.
4. **Lifecycle logs were lost on reload.** They waited 5 s in memory, and the reload discarded them.

## Fix: one update mechanism, corrected

The fix keeps the existing single `UpdateManager` and offline worker. No second update mechanism was added.

- **Settle window.** A deployment must stay live for 2 minutes before a register moves to it. Rapid pushes become one screen change, straight to the newest. If the alias moves during verification, the register never reloads onto the superseded build.
- **Reload cap.** At most 3 reloads per hour across all deployments.
- **Stage before reloading.** The worker saves the target build's page and code files first. The reload, and every later retry or restart, then opens the new build even on a slow connection. If the target can't be staged, the register stays on its current build and tries again later; no attempt is used up.
- **High-water mark in the worker.** The worker remembers the newest build seen live. A saved copy older than that is only opened when the server is truly unreachable, as a last-resort offline register. It is flagged as stale and moves to the live build when the connection returns.
- **Stall recovery.** A reload that hasn't replaced the page within 45 s, or a page restored from the back/forward cache, resumes checking. Attempts stay bounded (2 per target), and the register retries after 30 minutes, so there is no loop and no permanent old build.
- **Tap cover.** A full-screen "Updating the POS…" cover blocks taps between leaving the page and the new one opening.
- **Durable lifecycle logs.** `app.*` events go to device storage first and are sent immediately. The next page sends anything left. New events: `app.reload`, `app.update_confirmed`, `app.reload_stalled`, `app.update_blocked`, `app.stage_failed` and `app.offline_copy_opened`. `app.update_state` now includes the waiting reason, and repeats for the same target no longer churn.

The existing protections are unchanged:
- The full set of order, payment, tip, signature, print and sync guards.
- The server pending-operations check.
- The high-water mark that rejects older builds.
- The Web Lock that keeps a second tab from taking over the register.
- No-store POS HTML.
- The Vercel ignored-build release guard.

## Permanent CI guards (run on every push and pull request)

- `tests/screen-stability-invariants.test.ts` fails the build if any of these return:
  - a second reload path, or a second `UpdateManager`;
  - `router.refresh` or a location assignment in POS code;
  - staging or durable logging removed;
  - the settle window under 60 s or the cap above 3;
  - a worker that navigates or reloads pages;
  - POS HTML or worker caching changed;
  - the release guard removed;
  - an Android restore-state or reload-on-resume;
  - the browser suite dropped from CI.
- `tests/update-switching-regression.test.ts` covers the manager: settle, collapse, cap, stage, stall, blocked recovery and logging order.
- `tests/pos-offline-worker-switching.test.ts` covers the worker: high water, staged stand-in, last-resort stale copy, stage refusals.
- `e2e/screen-stability-local.spec.ts` (new CI job `screen-stability`) uses real Chromium with the real worker and real update manager against a fixture that deploys builds and slows or breaks the network (`npm run test:screen-stability`).

## Not proven by these tests

Browser tests are not the Elo hardware. Still to confirm on the device:
- WebView 156 behaviour of the worker's message channel;
- Android's native error-page retry;
- an app restart while offline;
- reader, printer and caller-ID behaviour after an update.

The first move onto this release is governed by the code already running on the Elo. If that page is in the old "departed" state, it will not update by itself, so **the POS app must be closed and reopened once at a quiet moment** (do not clear app data).
