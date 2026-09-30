package com.waynespizza.pos;

import android.app.Application;

import com.stripe.stripeterminal.TerminalApplicationDelegate;

/** Lets Stripe's Terminal SDK follow the app's lifecycle (required by the SDK). */
public class WaynesPosApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        TerminalApplicationDelegate.onCreate(this);
    }
}
