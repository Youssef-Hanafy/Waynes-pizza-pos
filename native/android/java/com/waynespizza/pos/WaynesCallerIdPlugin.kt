package com.waynespizza.pos

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.net.SocketException

/**
 * Wayne's POS — caller ID listener (build sheet §19, §52).
 *
 * Listens for the CallerID.com Whozz Calling? unit's UDP broadcasts on the
 * configured port (factory default 3520) and hands every packet, untouched, to
 * the web app as a "packet" event.  Parsing happens in ONE place — the web
 * app's parser, checked against CallerID.com's Ethernet Link manual — so this
 * file never interprets the record (§19: do not invent the packet parser).
 *
 * Bytes are decoded as ISO-8859-1 so each byte stays one character: the
 * record's header carries fixed-width unit/serial bytes and is read from the
 * 21st character, as the manual says.
 *
 * Android 17 (API 37) requires the ACCESS_LOCAL_NETWORK runtime permission to
 * receive UDP broadcasts; without it the socket fails with EPERM.  A denial is
 * reported as state "permission_denied" so Admin → Hardware can say so (§63).
 */
@CapacitorPlugin(
    name = "WaynesCallerId",
    permissions = [Permission(alias = "localNetwork", strings = ["android.permission.ACCESS_LOCAL_NETWORK"])]
)
class WaynesCallerIdPlugin : Plugin() {
    @Volatile private var socket: DatagramSocket? = null
    @Volatile private var state = "stopped"
    @Volatile private var detail = ""
    private var listener: Thread? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var expectedSender: String? = null

    private fun needsLocalNetworkPermission() = Build.VERSION.SDK_INT >= 37

    @PluginMethod
    fun start(call: PluginCall) {
        if (needsLocalNetworkPermission() && getPermissionState("localNetwork") != PermissionState.GRANTED) {
            requestPermissionForAlias("localNetwork", call, "afterPermission")
            return
        }
        begin(call)
    }

    @PermissionCallback
    private fun afterPermission(call: PluginCall) {
        if (getPermissionState("localNetwork") == PermissionState.GRANTED) {
            begin(call)
        } else {
            state = "permission_denied"
            detail = "Local network permission unavailable"
            call.reject(detail, "PERMISSION_DENIED")
        }
    }

    private fun begin(call: PluginCall) {
        val port = call.getInt("port") ?: 3520
        val bindAddress = call.getString("bindAddress") ?: "0.0.0.0"
        expectedSender = call.getString("deviceIp")?.takeIf { it.isNotBlank() }
        stopListening()
        try {
            // Some Wi-Fi drivers drop broadcast frames unless an app holds this lock.
            val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            multicastLock = wifi.createMulticastLock("waynes-caller-id").apply { setReferenceCounted(false); acquire() }

            val opened = DatagramSocket(null).apply {
                reuseAddress = true
                broadcast = true
                bind(InetSocketAddress(bindAddress, port))
            }
            socket = opened
            state = "listening"
            detail = "UDP $bindAddress:$port"
            listener = Thread({ receiveLoop(opened) }, "waynes-caller-id").apply { isDaemon = true; start() }
            call.resolve()
        } catch (error: Exception) {
            state = if (error is SocketException && error.message?.contains("EPERM") == true) "permission_denied" else "error"
            detail = error.message ?: "Could not open UDP port $port"
            releaseLock()
            call.reject(detail)
        }
    }

    private fun receiveLoop(opened: DatagramSocket) {
        val buffer = ByteArray(2048)
        while (!opened.isClosed) {
            try {
                val packet = DatagramPacket(buffer, buffer.size)
                opened.receive(packet)
                val from = packet.address?.hostAddress ?: ""
                if (expectedSender != null && from != expectedSender) continue
                val text = String(packet.data, packet.offset, packet.length, Charsets.ISO_8859_1)
                val event = JSObject().apply {
                    put("text", text)
                    put("from", from)
                    put("receivedAt", System.currentTimeMillis())
                }
                notifyListeners("packet", event)
            } catch (error: Exception) {
                if (opened.isClosed) break
                state = "error"
                detail = error.message ?: "Receive failed"
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        stopListening()
        call.resolve()
    }

    @PluginMethod
    fun status(call: PluginCall) {
        call.resolve(JSObject().apply { put("state", state); put("detail", detail) })
    }

    private fun stopListening() {
        socket?.close()
        socket = null
        listener = null
        releaseLock()
        if (state == "listening") state = "stopped"
    }

    private fun releaseLock() {
        multicastLock?.let { if (it.isHeld) it.release() }
        multicastLock = null
    }

    override fun handleOnDestroy() {
        stopListening()
        super.handleOnDestroy()
    }
}
