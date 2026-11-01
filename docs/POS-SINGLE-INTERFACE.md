# Single authoritative POS release

Baseline: production main dfd365a88990dd21d61479a305202e0a80c2b036, verified against the live /api/version before changes. This contains the latest menu pricing, delivery tip, customer checkout, and Elo lifecycle features; the original local branch was behind it. No financial, database, authentication, layout, menu, printing or order code is changed by this fix.

## Source and cause

The register mounts only src/app/pos/page.tsx → OneTab → PosApp in src/app/pos/pos-app.tsx. Its imported screens/components and src/app/globals.css define the current design. The separate /pos/display customer display and /pos/admin-pin authorization screen are required parts of that design, not obsolete registers. Kitchen, driver, storefront and back office are separate working features.

No tracked standalone HTML interface, bundled Android HTML/assets, alternate register component tree, UI version toggle, or alternate register route exists in this baseline. The old legacy-webview.css and its generator were already deleted by 3b3b6e0; the shared PostCSS layer-flattening transform remains necessary for the Elo's older WebView. Deleting working screens would remove features rather than consolidate the UI.

The remaining old interface was a runtime deployment snapshot. public/pos-sw.js cached complete authenticated HTML and old executable assets under wayne-pos-v1-* across deployments. dfd365a still explicitly served an older saved page on total network failure. Android's error retry to the plain /pos URL could enter that fallback again. Unmarked saved-shortcut/restart/refresh navigations were also eligible. Cache headers on the server cannot override a worker's Cache Storage response.

## Removed implementation

Removed all executable page snapshot read/write, static Cache Storage serving, offline fallback selection, worker high-water storage, target HTML/asset staging, and associated stale snapshot regression tests. The replacement worker remains at the installed URL/scope so existing devices receive the fix. It does not read or write executable caches, and removes only wayne-pos-*-pages/static/meta disposable frontend caches on activation. No forced reload during activation.

All POS document navigations fetch with cache:no-store. A connection failure or timeout produces a non-POS 503 recovery document with a retry link and automatic retry. An already open POS retains its existing offline order workflow; reopening while offline intentionally requires connection recovery instead of running an unverified historical UI. The existing single safe-update manager, busy guards, version verification, settle period and reload limits remain intact. Target preflight verifies live HTML/server build identities without storing a snapshot. Immutable Next assets still use deployment-specific URLs and browser caching.

Android 1.5.2/code 8 additionally uses LOAD_NO_CACHE. Application ID, native bridge, cookies, DOM storage and operational records are preserved. One singleTask launcher remains, startup always opens https://app.hanafymedia.com/pos, and no saved WebView state or offline POS bundle is restored.

## Rollout and Elo actions

Deploy by fast-forwarding production main through the existing Git → Vercel workflow. No migration or credentials/configuration changes. Verify /api/version reports the release commit and /pos-sw.js contains network-only worker 5. Existing installed workers cannot be patched while a device is disconnected; perform the first cutover online after finishing/saving active orders and reconciling any in-flight payments. Close duplicate POS tabs, reopen https://app.hanafymedia.com/pos online, then verify More → This app shows the deployed website/server identity and pos-sw 5 (network-only). This is also needed for an old page that is already running historical JavaScript.

Android APK: android/app/build/outputs/apk/debug/app-debug.apk. It opens the production address by default. To install on the store Elo using USB debugging (replace SERIAL with the device serial from the first command):

```sh
adb devices -l
adb -s SERIAL shell pm list packages -3
adb -s SERIAL shell dumpsys package com.waynespizza.pos
adb -s SERIAL install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Use an APK signed with the same key as the installed com.waynespizza.pos. If install reports INSTALL_FAILED_UPDATE_INCOMPATIBLE, rebuild/sign with the existing store signing key; do not uninstall the app to bypass it. Never run pm clear, clear site/app data, delete localStorage/IndexedDB, or uninstall a register with unsynchronized work. The repository has one application ID/launcher; no connected Elo was available to inventory other installed packages. Consequently no specific obsolete installed package has been identified for removal. Inspect package/launcher identities on the device before taking any such action.

After updating, open Wayne's POS and verify version 1.5.2/code 8 plus the live website identity. The web worker migration is independently effective on existing APKs once delivered online; the new APK adds native cache defense. Clearing operational storage is neither required nor permitted by this fix.

Local validation includes lint, TypeScript, full Vitest, production Next build, Android debug APK build, real Chromium deployment/refresh/reconnect/restart and cache-migration tests. Browser deployment-transition tests exercise the real worker/update manager with a synthetic server, not physical hardware or authenticated production transactions. No live customer charge is used. Physical Elo, reader, cash drawer, caller ID and printer acceptance requires the store device.

Validation for this change: lint and TypeScript passed; Vitest 144 files/970 tests passed, 1 file/4 tests skipped (opt-in Stripe sandbox proof); production build passed and its manifest contained only /pos, /pos/display and /pos/admin-pin UI pages (plus the display manifest); all 7 local Chromium stability tests passed, including legacy-cache deletion, offline refresh/new-tab restart/reconnect and operational outbox/draft preservation. Android debug build succeeded with the installed SDK/JBR (1.5.2/code 8); APK inventory contained no HTML or bundled POS executable assets. adb devices listed no connected devices. Initial Android build needed ANDROID_HOME set to the existing SDK; rebuilding with it passed.
