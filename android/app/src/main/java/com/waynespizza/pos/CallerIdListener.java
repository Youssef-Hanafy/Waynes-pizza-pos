package com.waynespizza.pos;

import android.content.Context;
import android.net.wifi.WifiManager;

import org.json.JSONException;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetSocketAddress;
import java.net.SocketException;
import java.nio.charset.StandardCharsets;

/**
 * Wayne's POS: caller ID listener (build sheet §19, §52).
 *
 * Listens for the CallerID.com Whozz Calling? unit's UDP broadcasts on the
 * configured port (factory default 3520) and hands every packet, untouched,
 * to the web app.  Parsing happens in ONE place, the web app's parser, which
 * is checked against CallerID.com's Ethernet Link manual; this class never
 * interprets the record (§19: do not invent the packet parser).
 *
 * Bytes are decoded as ISO-8859-1 so each byte stays one character: the
 * record's header carries fixed-width unit/serial bytes and is read from the
 * 21st character, as the manual says.
 */
final class CallerIdListener {
    interface PacketSink {
        void deliver(String text, String from, long receivedAt);
    }

    private final Context context;
    private final PacketSink sink;
    private volatile DatagramSocket socket;
    private volatile String state = "stopped";
    private volatile String detail = "";
    private volatile String expectedSender;
    private WifiManager.MulticastLock multicastLock;

    CallerIdListener(Context context, PacketSink sink) {
        this.context = context.getApplicationContext();
        this.sink = sink;
    }

    /** Opens the port. Returns null when listening, or what went wrong. */
    synchronized String start(int port, String bindAddress, String deviceIp) {
        stop();
        String bind = bindAddress == null || bindAddress.trim().isEmpty() ? "0.0.0.0" : bindAddress.trim();
        expectedSender = deviceIp == null || deviceIp.trim().isEmpty() ? null : deviceIp.trim();
        try {
            // Some Wi-Fi drivers drop broadcast frames unless an app holds this lock.
            WifiManager wifi = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                multicastLock = wifi.createMulticastLock("waynes-caller-id");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            }
            DatagramSocket opened = new DatagramSocket(null);
            opened.setReuseAddress(true);
            opened.setBroadcast(true);
            opened.bind(new InetSocketAddress(bind, port));
            socket = opened;
            state = "listening";
            detail = "UDP " + bind + ":" + port;
            Thread listener = new Thread(() -> receiveLoop(opened), "waynes-caller-id");
            listener.setDaemon(true);
            listener.start();
            return null;
        } catch (SocketException | SecurityException error) {
            String message = error.getMessage() == null ? "Could not open UDP port " + port : error.getMessage();
            state = error instanceof SecurityException || message.contains("EPERM") || message.contains("EACCES") ? "permission_denied" : "error";
            detail = "permission_denied".equals(state) ? "Local network permission unavailable" : message;
            releaseLock();
            return detail;
        }
    }

    private void receiveLoop(DatagramSocket opened) {
        byte[] buffer = new byte[2048];
        while (!opened.isClosed()) {
            try {
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                opened.receive(packet);
                String from = packet.getAddress() == null ? "" : packet.getAddress().getHostAddress();
                String only = expectedSender;
                if (only != null && !only.equals(from)) continue;
                String text = new String(packet.getData(), packet.getOffset(), packet.getLength(), StandardCharsets.ISO_8859_1);
                sink.deliver(text, from == null ? "" : from, System.currentTimeMillis());
            } catch (Exception error) {
                if (opened.isClosed()) break;
                state = "error";
                detail = error.getMessage() == null ? "Receive failed" : error.getMessage();
            }
        }
    }

    synchronized void stop() {
        DatagramSocket open = socket;
        socket = null;
        if (open != null) open.close();
        releaseLock();
        if ("listening".equals(state)) state = "stopped";
    }

    void markPermissionDenied() {
        state = "permission_denied";
        detail = "Local network permission unavailable";
    }

    boolean permissionDenied() {
        return "permission_denied".equals(state);
    }

    String statusJson() {
        JSONObject status = new JSONObject();
        try {
            status.put("state", state);
            status.put("detail", detail);
        } catch (JSONException ignored) {
            // Only constant keys: cannot happen.
        }
        return status.toString();
    }

    private void releaseLock() {
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        multicastLock = null;
    }
}
