# Wayne's POS Android app

The app is a full-screen window onto the POS website (`https://waynes-pizza-pos.vercel.app/pos`) plus the two things a web browser can't do:

| Ability | Does | Code |
| --- | --- | --- |
| Caller ID | Listens for the CallerID.com box's UDP broadcasts (port 3520) and passes each packet, untouched, to the POS | `CallerIdListener.java` |
| Printing | Sends receipts and kitchen tickets (already encoded by the POS) straight to the printers' IP:9100, and pulses the cash drawer | `NativeBridge.java` |

Everything else stays in the website: screens, the caller ID parser, receipt layouts, orders, the print station. **Updating the POS never needs a new app.** Only changes to these two abilities do.

The page reaches the app through `window.WaynesAndroid`. The web side of that contract is `src/hardware/native/bridge.ts`. Only the POS site itself can use it; any other page loaded in the app is ignored. Printers must have store-network addresses (10.x, 172.16–31.x, 192.168.x).

```
android/                                     open THIS folder in Android Studio
  app/build.gradle.kts                       app id com.waynespizza.pos, POS_URL, versions
  app/src/main/AndroidManifest.xml           permissions (internet, Wi-Fi multicast, local network)
  app/src/main/java/com/waynespizza/pos/
    MainActivity.java                        the WebView, back button, offline screen, local network permission
    NativeBridge.java                        window.WaynesAndroid: printer sends, caller ID start/stop/status
    CallerIdListener.java                    UDP listener
```

It's plain Android with no extra libraries: Java, Android plugin 9.4.1, Gradle 9.6, compile/target SDK 37 (Android 17), min SDK 26 (Android 8). It was built from the same setup Android Studio Quail 4 generates.

## Build it

1. Android Studio → **File → Open** → choose `waynes-pizza-pos/android` (the `android` folder, not the repo root). Let the Gradle sync finish.
2. **Build → Generate App Bundles or APKs → Generate APKs.** The result is `android/app/build/outputs/apk/debug/app-debug.apk`.

A debug APK is signed with the debug key on this Mac. It installs fine on the store tablet, and later builds from **this same Mac** install over it as updates. For a permanent key (to build updates from any computer), use **Build → Generate Signed App Bundle or APK → APK**, create a keystore, and **keep the keystore file and password safe**. Every later update must be signed with it.

## Put it on the tablet

1. Copy `app-debug.apk` to the tablet (USB cable, Google Drive, or email it to yourself) and open it.
2. Android asks to allow installing from that source (Files, Drive, Chrome…): allow it, then **Install**.
3. Open **Wayne's POS** and sign in with the register's staff account.
4. When Android 17 asks about **devices on your local network / nearby devices**, tap **Allow**. Without it, caller ID shows *Local network permission unavailable* and printing waits. To fix later: Settings → Apps → Wayne's POS → Permissions.

## Turn things on

* **Printing:** POS → **More → Print station** → *This register is the print station* (one register only). Admin → Hardware → *Test receipt printer / Test kitchen printer / Open cash drawer* must be pressed **from this app**. See `docs/PRINTER_SETUP.md`.
* **Caller ID:** Admin → Hardware → *Caller ID provider* → **Android app**, UDP port 3520, save. Call Line 1 and Line 2 from a cell phone and tick the results on Admin → Pilot.

## Notes

* Tablet on Wayne's **store network** (addresses starting 10.10.10.), not a guest Wi-Fi. The printers and caller ID box are only reachable there.
* The screen stays on while the app is open. For a locked-down register, use Android's **App pinning** (Settings → Security → App pinning).
* If the POS can't be reached, the app shows *Can't reach the POS* and retries every 10 seconds.
* To point the app at a different address (e.g. waynespizzaofworcester.com once it serves the POS), change `POS_URL` in `android/app/build.gradle.kts` and rebuild.
* Don't change the caller ID box's DIP switches or settings while Thrive still uses it (§2.1). Both systems can listen to the same broadcast.
