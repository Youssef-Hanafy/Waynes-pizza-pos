package com.waynespizza.pos;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;

import com.stripe.stripeterminal.Terminal;
import com.stripe.stripeterminal.external.callable.Callback;
import com.stripe.stripeterminal.external.callable.Cancelable;
import com.stripe.stripeterminal.external.callable.ConnectionTokenCallback;
import com.stripe.stripeterminal.external.callable.ConnectionTokenProvider;
import com.stripe.stripeterminal.external.callable.DiscoveryListener;
import com.stripe.stripeterminal.external.callable.MobileReaderListener;
import com.stripe.stripeterminal.external.callable.OfflineListener;
import com.stripe.stripeterminal.external.callable.PaymentIntentCallback;
import com.stripe.stripeterminal.external.callable.ReaderCallback;
import com.stripe.stripeterminal.external.callable.TerminalListener;
import com.stripe.stripeterminal.external.models.BatteryStatus;
import com.stripe.stripeterminal.external.models.CaptureMethod;
import com.stripe.stripeterminal.external.models.CreateConfiguration;
import com.stripe.stripeterminal.external.models.OfflineBehavior;
import com.stripe.stripeterminal.external.models.OfflineCardPresentDetails;
import com.stripe.stripeterminal.external.models.OfflineDetails;
import com.stripe.stripeterminal.external.models.OfflineStatus;
import com.stripe.stripeterminal.external.models.PaymentIntentParameters;
import com.stripe.stripeterminal.external.models.CollectPaymentIntentConfiguration;
import com.stripe.stripeterminal.external.models.ConfirmPaymentIntentConfiguration;
import com.stripe.stripeterminal.external.models.ConnectionConfiguration;
import com.stripe.stripeterminal.external.models.ConnectionStatus;
import com.stripe.stripeterminal.external.models.ConnectionTokenException;
import com.stripe.stripeterminal.external.models.DisconnectReason;
import com.stripe.stripeterminal.external.models.DiscoveryConfiguration;
import com.stripe.stripeterminal.external.models.PaymentIntent;
import com.stripe.stripeterminal.external.models.PaymentStatus;
import com.stripe.stripeterminal.external.models.Reader;
import com.stripe.stripeterminal.external.models.ReaderDisplayMessage;
import com.stripe.stripeterminal.external.models.ReaderInputOptions;
import com.stripe.stripeterminal.external.models.ReaderSoftwareUpdate;
import com.stripe.stripeterminal.external.models.TerminalErrorCode;
import com.stripe.stripeterminal.external.models.TerminalException;
import com.stripe.stripeterminal.log.LogLevel;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Wayne's POS: the Stripe Reader M2 (owner, 2026-09-30).
 *
 * The M2 is a Bluetooth reader that only works through Stripe's Terminal SDK,
 * so it lives here, in the app.  Everything else stays in the website: the
 * page asks the server to open a PaymentIntent, hands its client secret to
 * {@link #collect}, and the server re-reads Stripe before the order is marked
 * paid.  This class never sees a card number (the reader encrypts it) and
 * never holds Stripe's secret key — the connection token it needs is fetched
 * by the signed-in POS page ({@link Page#requestToken}).
 *
 * Answers go back through the same window.__waynesNativeResult(callId, ok,
 * code, message) channel as the printers.  Codes the web app relies on:
 *   DECLINED       the card didn't go through; the same payment takes the next card
 *   CANCELED       the cashier cancelled
 *   NOT_CONNECTED  no reader connected
 *   PERMISSION_DENIED  Bluetooth / Location permission refused
 *   ERROR          anything else (the page then asks Stripe what happened)
 */
final class StripeReader implements ConnectionTokenProvider, TerminalListener, MobileReaderListener, DiscoveryListener, OfflineListener {
    interface Page {
        void reply(String callId, boolean ok, String code, String message);
        void event(String type, JSONObject body);
        void requestToken(String requestId);
    }

    private static final String PREFS = "stripe_reader";
    private static final String SAVED_SERIAL = "serial";
    /** Cards stored offline that Stripe has received, until the page records them (owner, 2026-10-24). */
    private static final String FORWARDED = "forwarded_offline";
    /** How long a Bluetooth scan runs before giving up (seconds). */
    private static final int SCAN_SECONDS = 30;

    private final MainActivity activity;
    private final Page page;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, ConnectionTokenCallback> tokenWaiters = new ConcurrentHashMap<>();

    private volatile String state = "not_ready";
    private volatile String detail = "The card reader has not been connected yet.";
    private volatile Float updateProgress = null;
    private volatile Float battery = null;
    private volatile Boolean charging = null;
    private volatile String serial = null;

    // Touched on the main thread only.
    private Cancelable discovery;
    private Cancelable collecting;
    private String connectCallId;
    private String connectLocationId;
    private boolean connectingReader;
    private boolean fallbackScheduled;
    private List<Reader> lastSeen = new ArrayList<>();

    StripeReader(MainActivity activity, Page page) {
        this.activity = activity;
        this.page = page;
        this.prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.serial = prefs.getString(SAVED_SERIAL, null);
    }

    // ---- Status ----

    String statusJson() {
        return statusObject().toString();
    }

    private JSONObject statusObject() {
        JSONObject body = new JSONObject();
        try {
            body.put("state", state);
            body.put("detail", detail == null ? JSONObject.NULL : detail);
            body.put("serial", serial == null ? JSONObject.NULL : serial);
            body.put("battery", battery == null ? JSONObject.NULL : (double) battery);
            body.put("charging", charging == null ? JSONObject.NULL : charging);
            body.put("updateProgress", updateProgress == null ? JSONObject.NULL : (double) updateProgress);
            body.put("offlineStored", storedOfflineCount());
        } catch (JSONException ignored) {
            // Constant keys: cannot happen.
        }
        return body;
    }

    private void setState(String next, String why) {
        state = next;
        detail = why;
        page.event("status", statusObject());
    }

    private void prompt(String text) {
        JSONObject body = new JSONObject();
        try {
            body.put("text", text);
        } catch (JSONException ignored) {
            // Constant key.
        }
        page.event("prompt", body);
    }

    /** The state to return to after a payment or an update. */
    private String restingState() {
        return Terminal.isInitialized() && Terminal.getInstance().getConnectedReader() != null ? "connected" : "disconnected";
    }

    // ---- Connection token (asked of the signed-in POS page) ----

    @Override
    public void fetchConnectionToken(ConnectionTokenCallback callback) {
        final String requestId = UUID.randomUUID().toString();
        tokenWaiters.put(requestId, callback);
        page.requestToken(requestId);
        main.postDelayed(() -> {
            ConnectionTokenCallback waiting = tokenWaiters.remove(requestId);
            if (waiting != null) waiting.onFailure(new ConnectionTokenException("The POS page did not send a connection token. Is the POS open and signed in?"));
        }, 30_000);
    }

    void tokenResult(String requestId, boolean ok, String value) {
        ConnectionTokenCallback waiting = tokenWaiters.remove(requestId);
        if (waiting == null) return;
        if (ok && value != null && !value.isEmpty()) waiting.onSuccess(value);
        else waiting.onFailure(new ConnectionTokenException(value == null || value.isEmpty() ? "No connection token." : value));
    }

    // ---- Connecting ----

    static String[] permissionsNeeded() {
        if (Build.VERSION.SDK_INT >= 31) {
            return new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.ACCESS_COARSE_LOCATION};
        }
        // Android 11 and older need precise location for a Bluetooth scan.
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
    }

    private boolean initialize() {
        if (Terminal.isInitialized()) return true;
        try {
            // The offline listener: cards stored without a connection are forwarded to Stripe by the SDK when it is back.
            Terminal.init(activity.getApplicationContext(), LogLevel.NONE, this, this, this);
            return true;
        } catch (TerminalException failed) {
            setState("not_ready", "The card reader software could not start: " + failed.getErrorMessage());
            return false;
        }
    }

    @SuppressLint("MissingPermission")
    private boolean bluetoothOn() {
        BluetoothManager manager = activity.getSystemService(BluetoothManager.class);
        BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        return adapter != null && adapter.isEnabled();
    }

    /** Find the M2 and connect it.  Replies with its serial number. */
    void connect(final String callId, final String locationId, final boolean simulated) {
        activity.withPermissions(permissionsNeeded(), granted -> {
            if (!granted) {
                setState("disconnected", "Allow Wayne's POS to use Nearby devices and Location (Settings > Apps > Wayne's POS > Permissions).");
                page.reply(callId, false, "PERMISSION_DENIED", detail);
                return;
            }
            if (!simulated && !bluetoothOn()) {
                setState("disconnected", "Bluetooth is off. Turn it on in the tablet's quick settings.");
                page.reply(callId, false, "NOT_CONNECTED", detail);
                return;
            }
            if (!initialize()) {
                page.reply(callId, false, "ERROR", detail);
                return;
            }
            Reader current = Terminal.getInstance().getConnectedReader();
            if (current != null) {
                page.reply(callId, true, "", current.getSerialNumber() == null ? "" : current.getSerialNumber());
                return;
            }
            if (connectCallId != null) {
                page.reply(callId, false, "BUSY", "Already connecting to the card reader.");
                return;
            }
            startDiscovery(callId, locationId, simulated);
        });
    }

    @SuppressLint("MissingPermission")
    private void startDiscovery(String callId, String locationId, boolean simulated) {
        connectCallId = callId;
        connectLocationId = locationId;
        connectingReader = false;
        fallbackScheduled = false;
        lastSeen = new ArrayList<>();
        setState("discovering", "Press the reader's button once and keep it near the tablet.");
        discovery = Terminal.getInstance().discoverReaders(
                new DiscoveryConfiguration.BluetoothDiscoveryConfiguration(SCAN_SECONDS, simulated),
                this,
                new Callback() {
                    @Override
                    public void onSuccess() {
                        main.post(() -> {
                            discovery = null;
                            if (connectCallId != null && !connectingReader) {
                                finishConnect(false, "NOT_FOUND", "No card reader found. Press the reader's button once, keep it within a few feet of the tablet, and try again.");
                            }
                        });
                    }

                    @Override
                    public void onFailure(TerminalException failed) {
                        main.post(() -> {
                            discovery = null;
                            if (connectCallId != null && !connectingReader) finishConnect(false, codeFor(failed), wordsFor(failed));
                        });
                    }
                });
    }

    @Override
    public void onUpdateDiscoveredReaders(List<Reader> readers) {
        main.post(() -> {
            if (connectCallId == null || connectingReader || readers.isEmpty()) return;
            lastSeen = new ArrayList<>(readers);
            String saved = prefs.getString(SAVED_SERIAL, null);
            for (Reader reader : readers) {
                if (saved != null && saved.equals(reader.getSerialNumber())) {
                    connectTo(reader);
                    return;
                }
            }
            if (saved == null) {
                connectTo(readers.get(0));
                return;
            }
            // The store's own reader wasn't heard yet: give it a few seconds, then take whatever is here
            // (a replacement reader).
            if (!fallbackScheduled) {
                fallbackScheduled = true;
                main.postDelayed(() -> {
                    if (connectCallId != null && !connectingReader && !lastSeen.isEmpty()) connectTo(lastSeen.get(0));
                }, 8_000);
            }
        });
    }

    private void connectTo(Reader reader) {
        connectingReader = true;
        String name = reader.getSerialNumber() == null ? "the reader" : reader.getSerialNumber();
        setState("connecting", "Connecting to " + name + "…");
        Terminal.getInstance().connectReader(
                reader,
                new ConnectionConfiguration.BluetoothConnectionConfiguration(connectLocationId, true, this),
                new ReaderCallback() {
                    @Override
                    public void onSuccess(Reader connected) {
                        main.post(() -> {
                            serial = connected.getSerialNumber();
                            if (serial != null) prefs.edit().putString(SAVED_SERIAL, serial).apply();
                            battery = connected.getBatteryLevel();
                            charging = connected.isCharging();
                            updateProgress = null;
                            setState("connected", null);
                            finishConnect(true, "", serial == null ? "" : serial);
                        });
                    }

                    @Override
                    public void onFailure(TerminalException failed) {
                        main.post(() -> finishConnect(false, codeFor(failed), wordsFor(failed)));
                    }
                });
    }

    private void finishConnect(boolean ok, String code, String message) {
        String callId = connectCallId;
        connectCallId = null;
        connectingReader = false;
        if (discovery != null && !discovery.isCompleted()) discovery.cancel(quiet());
        discovery = null;
        if (!ok) setState("disconnected", message);
        if (callId != null) page.reply(callId, ok, code, message);
    }

    /** Forget this reader (e.g. it was replaced) and disconnect. */
    void disconnect(final String callId) {
        prefs.edit().remove(SAVED_SERIAL).apply();
        serial = null;
        if (!Terminal.isInitialized() || Terminal.getInstance().getConnectedReader() == null) {
            setState("disconnected", null);
            page.reply(callId, true, "", "");
            return;
        }
        Terminal.getInstance().disconnectReader(new Callback() {
            @Override
            public void onSuccess() {
                main.post(() -> {
                    setState("disconnected", null);
                    page.reply(callId, true, "", "");
                });
            }

            @Override
            public void onFailure(TerminalException failed) {
                main.post(() -> page.reply(callId, false, "ERROR", wordsFor(failed)));
            }
        });
    }

    // ---- Taking a card ----

    /** Take a card for the PaymentIntent the server opened.  Replies with the intent id when approved. */
    void collect(final String callId, final String clientSecret) {
        if (!Terminal.isInitialized() || Terminal.getInstance().getConnectedReader() == null) {
            page.reply(callId, false, "NOT_CONNECTED", "The card reader isn't connected. Press its button once, then Connect reader.");
            return;
        }
        if (collecting != null && !collecting.isCompleted()) {
            page.reply(callId, false, "BUSY", "The reader is already taking a card.");
            return;
        }
        setState("collecting", null);
        prompt("Tap, insert or swipe the card");
        Terminal.getInstance().retrievePaymentIntent(clientSecret, new PaymentIntentCallback() {
            @Override
            public void onSuccess(PaymentIntent intent) {
                main.post(() -> process(callId, intent));
            }

            @Override
            public void onFailure(TerminalException failed) {
                main.post(() -> {
                    setState(restingState(), null);
                    page.reply(callId, false, "ERROR", "The payment could not be loaded on the reader: " + failed.getErrorMessage());
                });
            }
        });
    }

    private void process(final String callId, PaymentIntent intent) {
        collecting = Terminal.getInstance().processPaymentIntent(
                intent,
                new CollectPaymentIntentConfiguration.Builder().build(),
                new ConfirmPaymentIntentConfiguration.Builder().build(),
                new PaymentIntentCallback() {
                    @Override
                    public void onSuccess(PaymentIntent done) {
                        main.post(() -> {
                            collecting = null;
                            setState(restingState(), null);
                            page.reply(callId, true, "", done.getId() == null ? "" : done.getId());
                        });
                    }

                    @Override
                    public void onFailure(TerminalException failed) {
                        main.post(() -> {
                            collecting = null;
                            setState(restingState(), null);
                            page.reply(callId, false, collectCodeFor(failed), collectWordsFor(failed));
                        });
                    }
                });
    }

    // ---- Taking a card with no connection (owner, 2026-10-24) ----

    /**
     * Take a card for an order the POS saved offline.  The SDK creates the
     * payment itself (no server needed) and, with no internet, the reader
     * stores the card; it is sent to Stripe as soon as the tablet is online
     * (onPaymentIntentForwarded).  With internet it simply goes through now.
     * Replies with JSON {offline_key, intent_id, stored, brand, last4}.
     */
    void collectOffline(final String callId, final long amountCents, final String offlineKey, final String orderKey, final String workspaceId, final String description) {
        if (!Terminal.isInitialized() || Terminal.getInstance().getConnectedReader() == null) {
            page.reply(callId, false, "NOT_CONNECTED", "The card reader isn't connected. Press its button once, then Connect reader.");
            return;
        }
        if (collecting != null && !collecting.isCompleted()) {
            page.reply(callId, false, "BUSY", "The reader is already taking a card.");
            return;
        }
        Map<String, String> metadata = new HashMap<>();
        metadata.put("wayne_offline_key", offlineKey);
        metadata.put("wayne_order_key", orderKey);
        metadata.put("wayne_entry", "terminal");
        metadata.put("wayne_offline", "true");
        if (workspaceId != null && !workspaceId.isEmpty()) metadata.put("hanafy_workspace_id", workspaceId);
        PaymentIntentParameters params = new PaymentIntentParameters.Builder()
                .setAmount(amountCents)
                .setCurrency("usd")
                .setCaptureMethod(CaptureMethod.Automatic)
                .setDescription(description == null ? "" : description)
                .setMetadata(metadata)
                .build();
        setState("collecting", null);
        prompt("Tap, insert or swipe the card");
        Terminal.getInstance().createPaymentIntent(params, new PaymentIntentCallback() {
            @Override
            public void onSuccess(PaymentIntent intent) {
                main.post(() -> processOffline(callId, offlineKey, intent));
            }

            @Override
            public void onFailure(TerminalException failed) {
                main.post(() -> {
                    setState(restingState(), null);
                    page.reply(callId, false, collectCodeFor(failed), offlineWordsFor(failed));
                });
            }
        }, new CreateConfiguration(OfflineBehavior.PREFER_ONLINE));
    }

    private void processOffline(final String callId, final String offlineKey, PaymentIntent intent) {
        collecting = Terminal.getInstance().processPaymentIntent(
                intent,
                new CollectPaymentIntentConfiguration.Builder().build(),
                new ConfirmPaymentIntentConfiguration.Builder().build(),
                new PaymentIntentCallback() {
                    @Override
                    public void onSuccess(PaymentIntent done) {
                        main.post(() -> {
                            collecting = null;
                            setState(restingState(), null);
                            JSONObject body = new JSONObject();
                            try {
                                OfflineDetails offline = done.getOfflineDetails();
                                OfflineCardPresentDetails card = offline == null ? null : offline.getCardPresentDetails();
                                body.put("offline_key", offlineKey);
                                body.put("intent_id", done.getId() == null ? JSONObject.NULL : done.getId());
                                body.put("stored", done.getId() == null);
                                body.put("brand", card == null || card.getBrand() == null ? "" : card.getBrand());
                                body.put("last4", card == null || card.getLast4() == null ? "" : card.getLast4());
                            } catch (JSONException ignored) {
                                // Constant keys.
                            }
                            page.reply(callId, true, "", body.toString());
                        });
                    }

                    @Override
                    public void onFailure(TerminalException failed) {
                        main.post(() -> {
                            collecting = null;
                            setState(restingState(), null);
                            page.reply(callId, false, collectCodeFor(failed), offlineWordsFor(failed));
                        });
                    }
                });
    }

    private static String offlineWordsFor(TerminalException failed) {
        TerminalErrorCode code = failed.getErrorCode();
        String name = code == null ? "" : code.name();
        if (name.contains("OFFLINE") && name.contains("LIMIT")) return "The card reader's offline limit was reached. Take cash, or wait for the connection.";
        if (name.contains("OFFLINE")) return "The card reader can't take cards offline yet (it must connect online once first). Take cash, or wait for the connection.";
        return collectWordsFor(failed);
    }

    // ---- OfflineListener ----

    @Override
    public void onOfflineStatusChange(OfflineStatus status) {
        main.post(() -> page.event("status", statusObject()));
    }

    @Override
    public void onPaymentIntentForwarded(PaymentIntent intent, TerminalException failed) {
        Map<String, String> metadata = intent == null ? null : intent.getMetadata();
        final String key = metadata == null ? null : metadata.get("wayne_offline_key");
        if (key == null) return;
        JSONObject body = new JSONObject();
        try {
            body.put("offline_key", key);
            body.put("intent_id", intent.getId() == null ? JSONObject.NULL : intent.getId());
            body.put("status", intent.getStatus() == null ? "" : intent.getStatus().name().toLowerCase());
            body.put("error", failed == null ? JSONObject.NULL : failed.getErrorMessage());
        } catch (JSONException ignored) {
            // Constant keys.
        }
        main.post(() -> {
            saveForwarded(key, body);
            page.event("forwarded", body);
        });
    }

    @Override
    public void onForwardingFailure(TerminalException failed) {
        // The SDK keeps the cards and tries again by itself; the page sees the count in the status.
        main.post(() -> page.event("status", statusObject()));
    }

    private int storedOfflineCount() {
        try {
            if (!Terminal.isInitialized()) return 0;
            OfflineStatus status = Terminal.getInstance().getOfflineStatus();
            return status == null || status.getSdk() == null ? 0 : status.getSdk().getOfflinePaymentsCount();
        } catch (RuntimeException unavailable) {
            return 0;
        }
    }

    private JSONObject forwardedMap() {
        try {
            return new JSONObject(prefs.getString(FORWARDED, "{}"));
        } catch (JSONException unreadable) {
            return new JSONObject();
        }
    }

    private void saveForwarded(String key, JSONObject body) {
        JSONObject all = forwardedMap();
        try {
            all.put(key, body);
        } catch (JSONException ignored) {
            return;
        }
        prefs.edit().putString(FORWARDED, all.toString()).apply();
    }

    /** Cards Stripe has received that the page has not recorded yet (survives the app closing). */
    String forwardedJson() {
        JSONObject all = forwardedMap();
        JSONArray list = new JSONArray();
        Iterator<String> keys = all.keys();
        while (keys.hasNext()) {
            JSONObject entry = all.optJSONObject(keys.next());
            if (entry != null) list.put(entry);
        }
        return list.toString();
    }

    void ackForwarded(String key) {
        JSONObject all = forwardedMap();
        all.remove(key);
        prefs.edit().putString(FORWARDED, all.toString()).apply();
    }

    /** Stop taking a card (or stop looking for the reader). */
    void cancel(final String callId) {
        if (connectCallId != null && !connectingReader) finishConnect(false, "CANCELED", "Stopped looking for the card reader.");
        if (collecting == null || collecting.isCompleted()) {
            page.reply(callId, true, "", "");
            return;
        }
        collecting.cancel(new Callback() {
            @Override
            public void onSuccess() {
                main.post(() -> page.reply(callId, true, "", ""));
            }

            @Override
            public void onFailure(TerminalException failed) {
                // Too late to cancel (the card was already read): the page asks Stripe what happened.
                main.post(() -> page.reply(callId, false, "CANCEL_FAILED", wordsFor(failed)));
            }
        });
    }

    void shutdown() {
        if (discovery != null && !discovery.isCompleted()) discovery.cancel(quiet());
        if (collecting != null && !collecting.isCompleted()) collecting.cancel(quiet());
        for (Map.Entry<String, ConnectionTokenCallback> waiting : tokenWaiters.entrySet()) {
            waiting.getValue().onFailure(new ConnectionTokenException("The POS app closed."));
        }
        tokenWaiters.clear();
    }

    private static Callback quiet() {
        return new Callback() {
            @Override
            public void onSuccess() {
            }

            @Override
            public void onFailure(TerminalException ignored) {
            }
        };
    }

    // ---- Errors in words ----

    private static String codeFor(TerminalException failed) {
        TerminalErrorCode code = failed.getErrorCode();
        if (code == TerminalErrorCode.CANCELED) return "CANCELED";
        if (code == TerminalErrorCode.BLUETOOTH_PERMISSION_DENIED || code == TerminalErrorCode.LOCATION_SERVICES_DISABLED) return "PERMISSION_DENIED";
        if (code == TerminalErrorCode.NOT_CONNECTED_TO_READER || code == TerminalErrorCode.BLUETOOTH_DISCONNECTED
                || code == TerminalErrorCode.BLUETOOTH_SCAN_TIMED_OUT || code == TerminalErrorCode.BLUETOOTH_ERROR) return "NOT_CONNECTED";
        return "ERROR";
    }

    private static String wordsFor(TerminalException failed) {
        TerminalErrorCode code = failed.getErrorCode();
        if (code == TerminalErrorCode.BLUETOOTH_SCAN_TIMED_OUT) return "No card reader found. Press the reader's button once, keep it close, and try again.";
        if (code == TerminalErrorCode.LOCATION_SERVICES_DISABLED) return "Turn on Location in the tablet's settings — Stripe needs it to take card payments.";
        if (code == TerminalErrorCode.BLUETOOTH_PERMISSION_DENIED) return "Allow Wayne's POS to use Nearby devices (Settings > Apps > Wayne's POS > Permissions).";
        if (code == TerminalErrorCode.READER_CONNECTED_TO_ANOTHER_DEVICE) return "The reader is connected to another tablet or phone. Disconnect it there (or restart the reader) and try again.";
        if (code == TerminalErrorCode.READER_SOFTWARE_UPDATE_FAILED_BATTERY_LOW || code == TerminalErrorCode.READER_BATTERY_CRITICALLY_LOW) return "The reader's battery is too low. Charge it, then connect again.";
        if (code == TerminalErrorCode.CONNECTION_TOKEN_PROVIDER_ERROR) return "The POS couldn't authorise the reader with Stripe: " + failed.getErrorMessage();
        return failed.getErrorMessage();
    }

    private static String collectCodeFor(TerminalException failed) {
        TerminalErrorCode code = failed.getErrorCode();
        if (code == TerminalErrorCode.CANCELED) return "CANCELED";
        if (code == TerminalErrorCode.DECLINED_BY_STRIPE_API || code == TerminalErrorCode.DECLINED_BY_READER
                || code == TerminalErrorCode.CARD_READ_TIMED_OUT || code == TerminalErrorCode.CARD_INSERT_NOT_READ
                || code == TerminalErrorCode.CARD_SWIPE_NOT_READ || code == TerminalErrorCode.CARD_REMOVED
                || code == TerminalErrorCode.CARD_LEFT_IN_READER) return "DECLINED";
        if (code == TerminalErrorCode.NOT_CONNECTED_TO_READER || code == TerminalErrorCode.BLUETOOTH_DISCONNECTED) return "NOT_CONNECTED";
        return "ERROR";
    }

    private static String collectWordsFor(TerminalException failed) {
        TerminalErrorCode code = failed.getErrorCode();
        if (code == TerminalErrorCode.DECLINED_BY_STRIPE_API || code == TerminalErrorCode.DECLINED_BY_READER) return "The card was declined. Try another card.";
        if (code == TerminalErrorCode.CARD_READ_TIMED_OUT) return "No card was presented in time. Try again.";
        if (code == TerminalErrorCode.CARD_INSERT_NOT_READ || code == TerminalErrorCode.CARD_SWIPE_NOT_READ) return "The card couldn't be read. Try again, or tap instead.";
        if (code == TerminalErrorCode.CARD_REMOVED) return "The card was removed too early. Insert it again and leave it in.";
        if (code == TerminalErrorCode.NOT_CONNECTED_TO_READER || code == TerminalErrorCode.BLUETOOTH_DISCONNECTED) return "The card reader disconnected. Press its button, reconnect, and try again.";
        return failed.getErrorMessage();
    }

    // ---- TerminalListener ----

    @Override
    public void onConnectionStatusChange(ConnectionStatus status) {
        main.post(() -> {
            if ("updating".equals(state) || "collecting".equals(state)) return;
            if (status == ConnectionStatus.CONNECTED) setState("connected", null);
            else if (status == ConnectionStatus.CONNECTING) setState("connecting", detail);
            else if (status == ConnectionStatus.RECONNECTING) setState("connecting", "Reconnecting to the card reader…");
            else if (status == ConnectionStatus.DISCOVERING) setState("discovering", detail);
            else if (status == ConnectionStatus.NOT_CONNECTED && connectCallId == null) setState("disconnected", detail);
        });
    }

    @Override
    public void onPaymentStatusChange(PaymentStatus status) {
        // The page follows the payment through collect()'s answer.
    }

    // ---- MobileReaderListener ----

    @Override
    public void onRequestReaderInput(ReaderInputOptions options) {
        main.post(() -> prompt(inputWords(options)));
    }

    private static String inputWords(ReaderInputOptions options) {
        List<String> ways = new ArrayList<>();
        for (ReaderInputOptions.ReaderInputOption option : options.getOptions()) {
            switch (option) {
                case TAP: ways.add("tap"); break;
                case INSERT: ways.add("insert"); break;
                case SWIPE: ways.add("swipe"); break;
                default: break;
            }
        }
        if (ways.isEmpty()) return "Present the card";
        StringBuilder words = new StringBuilder();
        for (int index = 0; index < ways.size(); index++) {
            if (index > 0) words.append(index == ways.size() - 1 ? " or " : ", ");
            words.append(ways.get(index));
        }
        String text = words.append(" the card").toString();
        return Character.toUpperCase(text.charAt(0)) + text.substring(1);
    }

    @Override
    public void onRequestReaderDisplayMessage(ReaderDisplayMessage message) {
        final String text;
        switch (message) {
            case RETRY_CARD: text = "Try the card again"; break;
            case INSERT_CARD: text = "Insert the card"; break;
            case INSERT_OR_SWIPE_CARD: text = "Insert or swipe the card"; break;
            case SWIPE_CARD: text = "Swipe the card"; break;
            case REMOVE_CARD: text = "Remove the card"; break;
            case MULTIPLE_CONTACTLESS_CARDS_DETECTED: text = "More than one card — tap just one"; break;
            case TRY_ANOTHER_READ_METHOD: text = "Try inserting or swiping instead"; break;
            case TRY_ANOTHER_CARD: text = "Try another card"; break;
            case CARD_REMOVED_TOO_EARLY: text = "Card removed too early — insert it again"; break;
            case CHECK_MOBILE_DEVICE: text = "Check your phone to finish paying"; break;
            default: text = message.toString(); break;
        }
        main.post(() -> prompt(text));
    }

    @Override
    public void onStartInstallingUpdate(ReaderSoftwareUpdate update, Cancelable cancelable) {
        main.post(() -> {
            updateProgress = 0f;
            setState("updating", "Installing a required card reader update. Keep the reader on and close by.");
        });
    }

    @Override
    public void onReportReaderSoftwareUpdateProgress(float progress) {
        main.post(() -> {
            updateProgress = progress;
            page.event("status", statusObject());
        });
    }

    @Override
    public void onFinishInstallingUpdate(ReaderSoftwareUpdate update, TerminalException failed) {
        main.post(() -> {
            updateProgress = null;
            setState(connectCallId != null ? "connecting" : restingState(), failed == null ? null : "The reader update didn't finish: " + wordsFor(failed));
        });
    }

    @Override
    public void onReportAvailableUpdate(ReaderSoftwareUpdate update) {
        // Optional updates become required later and then install on connect; nothing to do now.
    }

    @Override
    public void onReportLowBatteryWarning() {
        main.post(() -> {
            detail = "The card reader's battery is low. Charge it soon.";
            page.event("status", statusObject());
        });
    }

    @Override
    public void onBatteryLevelUpdate(float batteryLevel, BatteryStatus batteryStatus, boolean isCharging) {
        main.post(() -> {
            battery = batteryLevel;
            charging = isCharging;
            page.event("status", statusObject());
        });
    }

    @Override
    public void onDisconnect(DisconnectReason reason) {
        main.post(() -> setState("disconnected", "The card reader disconnected — reconnecting by itself. If it stays off, press its button once."));
    }

    @Override
    public void onReaderReconnectStarted(Reader reader, Cancelable cancelReconnect, DisconnectReason reason) {
        main.post(() -> setState("connecting", "Reconnecting to the card reader…"));
    }

    @Override
    public void onReaderReconnectSucceeded(Reader reader) {
        main.post(() -> setState("connected", null));
    }

    @Override
    public void onReaderReconnectFailed(Reader reader) {
        main.post(() -> setState("disconnected", "Reconnecting to the card reader… If it stays off, press its button once."));
    }
}
