package com.waynespizza.pos

import android.os.Bundle
import android.view.WindowManager
import com.getcapacitor.BridgeActivity

/**
 * Wayne's POS — the Android shell (build sheet §19, §61, §62).
 * It only registers the two hardware plugins and keeps the screen on; the POS
 * itself is the website, loaded from capacitor.config.json's server.url.
 */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(WaynesCallerIdPlugin::class.java)
        registerPlugin(WaynesPrinterPlugin::class.java)
        super.onCreate(savedInstanceState)
        // A register screen must not sleep in the middle of service.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
}
