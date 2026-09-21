package com.waynespizza.pos

import android.util.Base64
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.Executors

/**
 * Wayne's POS — network printer socket (build sheet §23, §59, §60).
 *
 * Sends bytes the web app already encoded (ESC/POS, only once the printer
 * model is confirmed) to the printer's IP:port on the store LAN.  It knows no
 * printer language itself.  A timeout or refusal rejects the call so the POS
 * shows "printer offline" instead of pretending it printed (§29).
 */
@CapacitorPlugin(
    name = "WaynesPrinter",
    permissions = [Permission(alias = "localNetwork", strings = ["android.permission.ACCESS_LOCAL_NETWORK"])]
)
class WaynesPrinterPlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor()

    @PluginMethod
    fun send(call: PluginCall) {
        val host = call.getString("host")
        val port = call.getInt("port")
        val data = call.getString("data")
        val timeout = call.getInt("timeoutMs") ?: 8000
        if (host.isNullOrBlank() || port == null || data.isNullOrEmpty()) {
            call.reject("host, port and data are required")
            return
        }
        worker.execute {
            try {
                Socket().use { socket ->
                    socket.connect(InetSocketAddress(host, port), timeout)
                    socket.soTimeout = timeout
                    socket.getOutputStream().apply {
                        write(Base64.decode(data, Base64.DEFAULT))
                        flush()
                    }
                }
                call.resolve()
            } catch (error: Exception) {
                call.reject("Printer $host:$port did not answer: ${error.message ?: "unknown error"}")
            }
        }
    }

    override fun handleOnDestroy() {
        worker.shutdownNow()
        super.handleOnDestroy()
    }
}
