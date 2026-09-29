package com.waynespizza.pos;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * Wayne's POS: the Android shell (build sheet §19, §61, §62).
 *
 * A full-screen WebView of the POS website plus the two things a browser
 * cannot do, exposed to the page as window.WaynesAndroid (see NativeBridge):
 * listening for the caller ID box's UDP broadcasts, and sending receipts and
 * kitchen tickets straight to the network printers.  Every screen and rule
 * stays in the website, so updating the POS never needs a new app.
 */
public class MainActivity extends Activity {
    /** Android 17 local network protection. Older Android versions don't have it. */
    static final String LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK";
    private static final int REQUEST_LOCAL_NETWORK = 17;

    private WebView webView;
    private NativeBridge bridge;
    private final List<Consumer<Boolean>> waitingForPermission = new ArrayList<>();
    private boolean askingPermission = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // A register screen must not sleep in the middle of service.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.wayne_green));
        webView = new WebView(this);
        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);
        keepClearOfSystemBars(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setUserAgentString(settings.getUserAgentString() + " WaynesPOSAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        bridge = new NativeBridge(this, webView, BuildConfig.POS_URL);
        webView.addJavascriptInterface(bridge, "WaynesAndroid");
        webView.setWebViewClient(new PosClient());
        webView.setWebChromeClient(new WebChromeClient());

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        }

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(BuildConfig.POS_URL);
        }
        // Ask for the local network up front so the first ring and the first ticket don't wait on a dialog.
        withLocalNetwork(granted -> { });
    }

    /** Android 15+ draws apps edge to edge: keep the POS clear of the status bar, navigation bar and keyboard. */
    private void keepClearOfSystemBars(View root) {
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
    }

    private void goBack() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else moveTaskToBack(true);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Android 12 and older; newer versions use the callback registered in onCreate.
        goBack();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Keep the sign-in if Android closes the app while it's in the background.
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        if (bridge != null) bridge.shutdown();
        if (webView != null) {
            webView.removeJavascriptInterface("WaynesAndroid");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // ---- Local network permission (Android 17) ----

    boolean hasLocalNetwork() {
        if (Build.VERSION.SDK_INT < 37) return true;
        try {
            getPackageManager().getPermissionInfo(LOCAL_NETWORK, 0);
        } catch (PackageManager.NameNotFoundException unknown) {
            // This Android build has no such permission: nothing to ask for.
            return true;
        }
        return checkSelfPermission(LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED;
    }

    /** Runs `then` on the main thread with whether the app may use the store's local network. */
    void withLocalNetwork(Consumer<Boolean> then) {
        runOnUiThread(() -> {
            if (hasLocalNetwork()) {
                then.accept(true);
                return;
            }
            waitingForPermission.add(then);
            if (!askingPermission) {
                askingPermission = true;
                requestPermissions(new String[]{LOCAL_NETWORK}, REQUEST_LOCAL_NETWORK);
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_LOCAL_NETWORK) return;
        askingPermission = false;
        boolean granted = hasLocalNetwork();
        List<Consumer<Boolean>> waiting = new ArrayList<>(waitingForPermission);
        waitingForPermission.clear();
        for (Consumer<Boolean> callback : waiting) callback.accept(granted);
    }

    // ---- Page loading ----

    private final class PosClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if ("https".equals(scheme) || "http".equals(scheme)) return false;
            // tel:, mailto:, maps and the like open in their own apps.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
                // Nothing on the tablet handles it; stay on the POS.
            }
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            bridge.setCurrentUrl(url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showOffline(view, String.valueOf(error.getDescription()));
        }
    }

    /** Shown when the POS can't be reached; retries by itself every 10 seconds. */
    private void showOffline(WebView view, String reason) {
        String url = TextUtils.htmlEncode(BuildConfig.POS_URL);
        String html = "<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F7F1E3;color:#1F3A2E;"
                + "font:18px system-ui,sans-serif;text-align:center}main{padding:32px;max-width:520px}"
                + "h1{font-size:28px;margin:0 0 12px}a{display:inline-block;margin-top:20px;padding:14px 28px;border-radius:14px;"
                + "background:#1F3A2E;color:#F7F1E3;text-decoration:none;font-weight:700}small{display:block;margin-top:16px;opacity:.6}</style></head>"
                + "<body><main><h1>Can't reach the POS</h1><p>Check the Wi-Fi. This screen tries again every 10 seconds.</p>"
                + "<a href='" + url + "'>Try again now</a><small>" + TextUtils.htmlEncode(reason) + "</small></main>"
                + "<script>setTimeout(function(){location.href='" + url + "'},10000)</script></body></html>";
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }
}
