package com.waynespizza.pos;

import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * window.WaynesAndroid: what the POS page can ask of the tablet.  The web
 * side is src/hardware/native/bridge.ts, which turns these calls into promises.
 *
 * Calls return at once; the answer comes back later through
 * window.__waynesNativeResult(callId, ok, code, message).  Codes the web app
 * relies on:
 *   NOT_CONNECTED     the printer never accepted the connection: nothing was sent, safe to retry
 *   SEND_INTERRUPTED  the connection opened, then broke: part of the ticket may have printed
 *   PERMISSION_DENIED the local network permission was refused
 *
 * Only the POS site itself may use this: calls from any other page are ignored.
 */
final class NativeBridge {
    private final MainActivity activity;
    private final WebView webView;
    private final String allowedHost;
    private final ExecutorService printerThreads = Executors.newCachedThreadPool();
    private final ExecutorService callerIdThread = Executors.newSingleThreadExecutor();
    private final CallerIdListener callerId;
    private volatile String currentUrl = "";

    NativeBridge(MainActivity activity, WebView webView, String posUrl) {
        this.activity = activity;
        this.webView = webView;
        this.allowedHost = Uri.parse(posUrl).getHost();
        this.callerId = new CallerIdListener(activity, this::deliverPacket);
    }

    void setCurrentUrl(String url) {
        currentUrl = url == null ? "" : url;
    }

    private boolean trusted() {
        Uri page = Uri.parse(currentUrl);
        return "https".equals(page.getScheme()) && allowedHost != null && allowedHost.equals(page.getHost());
    }

    // ---- Called from the page ----

    @JavascriptInterface
    public String info() {
        JSONObject info = new JSONObject();
        try {
            info.put("app", "Wayne's POS");
            info.put("version", BuildConfig.VERSION_NAME);
            info.put("android", Build.VERSION.SDK_INT);
            info.put("model", Build.MODEL);
        } catch (JSONException ignored) {
            // Only constant keys: cannot happen.
        }
        return info.toString();
    }

    /** Sends bytes the web app already encoded (ESC/POS) to a printer on the store network. */
    @JavascriptInterface
    public void printerSend(final String callId, final String host, final int port, final String base64, final int timeoutMs) {
        if (!trusted()) return;
        if (!isPrivateIpv4(host) || port < 1 || port > 65535) {
            reply(callId, false, "NOT_CONNECTED", "Printer address " + host + ":" + port + " is not on the store network.");
            return;
        }
        final byte[] bytes;
        try {
            bytes = Base64.decode(base64, Base64.DEFAULT);
        } catch (IllegalArgumentException bad) {
            reply(callId, false, "NOT_CONNECTED", "The ticket could not be read.");
            return;
        }
        final int timeout = Math.max(1000, Math.min(timeoutMs, 60000));
        activity.withLocalNetwork(granted -> {
            if (!granted) {
                reply(callId, false, "NOT_CONNECTED", "Allow Wayne's POS to use the local network (Settings > Apps > Wayne's POS > Permissions), then try again.");
                return;
            }
            printerThreads.execute(() -> send(callId, host, port, bytes, timeout));
        });
    }

    @JavascriptInterface
    public void callerIdStart(final String callId, final int port, final String bindAddress, final String deviceIp) {
        if (!trusted()) return;
        activity.withLocalNetwork(granted -> {
            if (!granted) {
                callerId.markPermissionDenied();
                reply(callId, false, "PERMISSION_DENIED", "Local network permission unavailable");
                return;
            }
            callerIdThread.execute(() -> {
                String problem = callerId.start(port, bindAddress, deviceIp);
                if (problem == null) reply(callId, true, "", "");
                else reply(callId, false, callerId.permissionDenied() ? "PERMISSION_DENIED" : "ERROR", problem);
            });
        });
    }

    @JavascriptInterface
    public void callerIdStop(final String callId) {
        if (!trusted()) return;
        callerIdThread.execute(() -> {
            callerId.stop();
            reply(callId, true, "", "");
        });
    }

    @JavascriptInterface
    public String callerIdStatus() {
        return callerId.statusJson();
    }

    // ---- Native work ----

    private void send(String callId, String host, int port, byte[] bytes, int timeout) {
        Socket socket = new Socket();
        try {
            try {
                socket.connect(new InetSocketAddress(host, port), timeout);
            } catch (IOException | SecurityException refused) {
                reply(callId, false, "NOT_CONNECTED", "Printer " + host + ":" + port + " is not answering (" + describe(refused)
                        + "). Check it is on and plugged into the network.");
                return;
            }
            try {
                socket.setSoTimeout(timeout);
                OutputStream out = socket.getOutputStream();
                out.write(bytes);
                out.flush();
                reply(callId, true, "", "");
            } catch (IOException broken) {
                reply(callId, false, "SEND_INTERRUPTED", "Printer " + host + ":" + port + " stopped mid-print (" + describe(broken)
                        + "). Check the paper before reprinting.");
            }
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
                // Already closed.
            }
        }
    }

    private void deliverPacket(String text, String from, long receivedAt) {
        String script = "window.__waynesNativePacket&&window.__waynesNativePacket("
                + JSONObject.quote(text) + "," + JSONObject.quote(from) + "," + receivedAt + ")";
        webView.post(() -> {
            if (trusted()) webView.evaluateJavascript(script, null);
        });
    }

    private void reply(String callId, boolean ok, String code, String message) {
        String script = "window.__waynesNativeResult&&window.__waynesNativeResult("
                + JSONObject.quote(callId) + "," + ok + "," + JSONObject.quote(code) + "," + JSONObject.quote(message) + ")";
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    void shutdown() {
        callerId.stop();
        printerThreads.shutdownNow();
        callerIdThread.shutdownNow();
    }

    private static String describe(Exception error) {
        String message = error.getMessage();
        return message == null || message.isEmpty() ? error.getClass().getSimpleName() : message;
    }

    /** Printers must be on the store's own network (10.x, 172.16-31.x, 192.168.x). */
    static boolean isPrivateIpv4(String host) {
        if (host == null) return false;
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        for (int index = 0; index < 4; index++) {
            try {
                octets[index] = Integer.parseInt(parts[index]);
            } catch (NumberFormatException notNumber) {
                return false;
            }
            if (octets[index] < 0 || octets[index] > 255) return false;
        }
        return octets[0] == 10
                || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                || (octets[0] == 192 && octets[1] == 168);
    }
}
