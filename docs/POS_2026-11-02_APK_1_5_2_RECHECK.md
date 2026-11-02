# APK 1.5.2 recheck — November 2, 2026

Inspected installer: `/Users/youssefhanafy/Wayne's Pizza POS/APK/WaynesPOS-1.5.2.apk`.
Package `com.waynespizza.pos`, versionName `1.5.2`, versionCode `8`.
SHA-256: `bcdd4519966f211bf7c405d693948d3bc06a270918c061bda593158ef6bf475d`.
APK signature verification passed; signing certificate SHA-256:
`ceb0e0f90078efd1adf458260a585f1f791ad32830edde2941dc827efc3b2529`.

The APK is a WebView shell, with no bundled HTML, JavaScript or CSS screen copies.
Its source uses LOAD_NO_CACHE and clears disposable WebView assets once per APK
version without clearing cookies or operational storage. The production version
endpoint returned commit `656ada4f2edc5d7db34512d8a271cc34e60435ab`, matching the
checkout baseline. Its live `/pos-sw.js` is the network-only worker reviewed here.
There is one register entry component, PosApp; no old/new design selector was found.
Historical source and reports outside the running app are not executable fallbacks.

The worker deletes legacy Wayne pages/static/meta caches on activation. It fetches
POS documents with no-store, with connection recovery rather than old saved UI.
The real-browser suite passed all seven cases including seeded old-cache removal,
offline restart, slow network, sequential deployments and active-order protection.
An already open pre-update register still needs a safe online reopen to adopt the
current document; remotely erasing running screens was not attempted.

All 18 existing register browser cases passed across eight screen sizes. A new
browser check also passed: modifier button rectangles stay identical across
reopening and switching between two category items with the same option set.
Database tests confirm a shared category option order. Different available option
sets, screen sizes and keyboard states can change physical grid coordinates;
this audit does not establish identical coordinates across those conditions.

A new isolated PostgreSQL test passed: save a customer with delivery address,
record a subsequent caller event with the normalized number, then read the phone
board as authorized staff and verify the saved customer ID, name and address.
Existing tests cover concurrent saves/order submission and restart recovery.

Found and fixed locally: pending customer saves used to expire silently after
three days offline. They now remain queued until acknowledged, with a seven-day
outage regression test. Also repaired two release/order guard tests to decode
file URLs correctly when the checkout path contains spaces.

Validation: full suite 999 tests passed, four opt-in tests skipped; 71 targeted tests passed; 26 browser checks passed (18 register,
7 real-worker stability, 1 new modifier-position case). Lint, TypeScript and the
Next production build passed. No production customer data was written, no APK
was replaced, and the new customer-queue change has not been deployed.

No Android devices were connected (`adb devices -l`). Physical Elo screen density,
Android keyboard/insets, installation, caller-ID box, printer and reader behavior
remain device acceptance checks, not conclusions of this desktop audit.
