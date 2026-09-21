# Wayne's POS Android app — setup (build sheet Phase 8)

The app is a thin shell around the website POS. It adds two native plugins and nothing else:

| Plugin | Does | Why a browser can't |
| --- | --- | --- |
| `WaynesCallerId` | Listens for the CallerID.com box's UDP broadcasts (port 3520 by default) and passes each packet to the POS untouched | Browsers can't open UDP sockets |
| `WaynesPrinter` | Sends bytes the POS already encoded to a network printer's IP:port | Browsers can't open raw TCP sockets |

Everything else stays in the website: the screens, the stores, the CallerID.com parser (checked against the official Ethernet Link manual), printing layouts, orders, customers. The native code does not change any of it (§62).

Source files in this repo:

```
capacitor.config.json                               app id, name, and the POS URL the app opens
native/android/java/com/waynespizza/pos/*.kt        MainActivity + the two plugins
native/android/AndroidManifest.additions.xml        permissions to paste into the manifest
native/android/offline/index.html                   shown only if the POS can't be reached
src/hardware/native/bridge.ts                       plugins → window.WaynesNativeHardware (web side)
```

## Build it (on the Mac)

The Android SDK and Capacitor packages couldn't be downloaded in the Claude workspace, so the app is built on your Mac. None of this has been compiled yet. Expect to fix small compile errors the first time.

1. Install **Android Studio** (it includes the Android SDK and a JDK).
2. In the repo:
   ```bash
   npm install @capacitor/core @capacitor/android
   npm install -D @capacitor/cli
   npx cap add android
   ```
3. Copy the three Kotlin files into the generated project, replacing its `MainActivity`:
   ```bash
   mkdir -p android/app/src/main/java/com/waynespizza/pos
   cp native/android/java/com/waynespizza/pos/*.kt android/app/src/main/java/com/waynespizza/pos/
   ```
   Delete any generated `MainActivity.java` so there is only one.
4. Open `android/app/src/main/AndroidManifest.xml` and paste the lines from
   `native/android/AndroidManifest.additions.xml` inside `<manifest>`.
5. `npx cap sync android`, then `npx cap open android`. In Android Studio, **Build → Generate Signed App Bundle / APK → APK**. Create a keystore the first time and **keep it safe**: every future update must be signed with the same key.
6. Install `WaynesPOS.apk` on the tablet (USB, or copy it over and open it). Allow installing from this source when Android asks (§61).

## Turn it on

1. Tablet on Wayne's **POS Wi-Fi**, not a guest network (§56).
2. Open the app and sign in. When Android asks for **Nearby devices / local network**, tap **Allow**. Android 17 needs this (`ACCESS_LOCAL_NETWORK`) to receive the caller ID broadcasts and reach printers. If it's denied, Admin → Hardware shows *Local network permission unavailable* (§63).
3. **Admin → Hardware → Caller ID provider → Android app**, check the UDP port (3520), save.
4. Call Line 1 and Line 2 from a cell phone. Tick the results on **Admin → Pilot**.

## Notes

* The app opens `https://waynespizzaofworcester.com/pos` (see `capacitor.config.json`). To test against a preview deploy, change `server.url`, then run `npx cap sync android`.
* Don't change the caller ID box's DIP switches or settings while Thrive still uses it (§2.1). Both systems can listen to the same broadcast.
* Kiosk / full-screen: use Android's *App pinning* (Settings → Security → App pinning) for now. A dedicated device-owner kiosk setup can come later if Wayne's wants it.
* `window.WaynesNativeHardware` is the whole contract. If the native layer is ever rewritten (a different shell, or a newer Capacitor), keep that shape and nothing in the POS changes.
