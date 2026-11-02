# Wayne’s POS integration — November 2, 2026

Production baseline: 9236b5320121b6cb94e17b54c25d13dcadfea6a6, independently read from the live version endpoint and fetched main.

## Integrated source

The UI audit commit 62c8599 was local only. Merge it with the current main order-preservation fix and customer-save/modifier-order commit 1b6516a. Keep the audited 22rem/16rem modifier layout, 44px touch targets, wrapped names, keyboard-aware dialogs, stable header status space, and caller dialog/focus protection. Register build changes require operator approval for the exact target, in addition to all existing idle/payment/printing guards.

The customer checkout reliability commits cf9e438/9b35b85 are already patch-equivalent to code in main, so they are not applied twice. Historical payment branches are already integrated or superseded by current main. The separate CI-upgrade-only branch is not a POS behavior fix. Old frontend snapshots are removed by the existing network-only worker; the native 1.5.2/code 8 source uses LOAD_NO_CACHE. No separately running POS hotfix daemon or launch agent was found on this Mac.

During integration, customer autosaves were made durable before the request and serialized per phone. A failed older request cannot overwrite newer queued typing. Added regression coverage for restart recovery and overlapping saves. The isolated menu-pricing test now explicitly opens its synthetic store all day; its prior failure depended on the wall-clock store hours. Production hours are unchanged.

## Database identity

Production already has 94 migration-history rows, including `20261102020618_resend_keeps_same_order` and `20261102023928_align_category_option_order`. Their source counterparts are `20261125080000_resend_keeps_same_order.sql` and `20261126080000_align_category_option_order.sql`. Do not blindly replay or rename production history. This cutover requires no production SQL changes. Staging was missing these two reviewed changes and receives only their exact source SQL, with capture execution disabled and no outbound integration destinations.

## Checks and limits

The integrated suite passed 997 tests, with four existing opt-in tests skipped. Seven real-worker Chromium screen-stability cases passed. Lint, TypeScript and the Next production build pass. The repeated full-register UI suite covers eight viewports, modifier controls, keyboard, caller interruption, update approval, reconnect, refresh and ownership; current evidence is retained in the organized Reports folder. Targeted customer queue tests pass after the final queue adjustment.

APK 1.5.2/code 8 was extracted from the already built, signed local artifact and verified with aapt/apksigner. Its package is com.waynespizza.pos and certificate SHA-256 is ceb0e0f90078efd1adf458260a585f1f791ad32830edde2941dc827efc3b2529. Operational data must be preserved by an in-place update using the same installed certificate. No Elo is connected; installation, hardware display stability, actual WebView density and reader/printer/caller acceptance are not verified by desktop tests.

## Organization

The canonical local folder is ~/Wayne’s Pizza POS (ASCII apostrophe in the actual filesystem name). APK contains the verified 1.5.2 installer and checksum. Source contains the current checkout. Archive retains other checkouts/installers; Reports and Reference retain release evidence and store assets. Compatibility symlinks at old locations preserve existing scripts and workspace references. This is local organization, not a remote backup. Credentials and private operational evidence stay in Operations/Private with restricted access.

Production promotion is authorized by the owner after checks pass, with the register confirmed idle. Recheck main/live identity immediately before a normal fast-forward push, then verify the exact READY build and public service health. Preserve all orders, drafts, financial schedules and historical print exceptions. Already running old documents need one safe online reopen to load the new guard.
