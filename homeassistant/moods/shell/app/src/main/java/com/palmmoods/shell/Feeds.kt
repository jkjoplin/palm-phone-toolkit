package com.palmmoods.shell

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.SystemClock
import org.json.JSONObject

/** Delivers one shell -> page event. Always called on the main thread. */
typealias Emit = (type: String, payload: JSONObject) -> Unit

/**
 * One source of shell -> page events. Feeds run between [start] (onResume) and
 * [stop] (onPause) and deliver on the main thread. [last] is replayed to every
 * freshly loaded page so it never waits for the next change.
 */
abstract class Feed(val type: String, private val emit: Emit) {
    var last: JSONObject? = null
        private set

    abstract fun start()
    abstract fun stop()

    /** Sends only when the payload differs from the last one sent. */
    protected fun publishIfChanged(payload: JSONObject) {
        if (payload.toString() == last?.toString()) return
        publish(payload)
    }

    protected fun publish(payload: JSONObject) {
        last = payload
        emit(type, payload)
    }
}

/** Only for system broadcasts (battery, Wi-Fi RSSI); API 33+ needs the export flag spelled out. */
@SuppressLint("UnspecifiedRegisterReceiverFlag")
internal fun Context.registerSystemReceiver(receiver: BroadcastReceiver, filter: IntentFilter): Intent? =
    if (Build.VERSION.SDK_INT >= 33) {
        registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
        registerReceiver(receiver, filter)
    }

/** "sensor": ambient light (lux, at most once per second) and proximity (near/far). */
class SensorFeed(context: Context, private val handler: Handler, emit: Emit) :
    Feed(ShellEvents.SENSOR, emit), SensorEventListener {

    private val manager = context.getSystemService(SensorManager::class.java)
    private val light: Sensor? = manager?.getDefaultSensor(Sensor.TYPE_LIGHT)
    // On most devices (the RPR0521 on the Palm included) the default proximity sensor is the wake-up one.
    private val proximity: Sensor? = manager?.getDefaultSensor(Sensor.TYPE_PROXIMITY)

    private var lux: Double? = null
    private var near: Boolean? = null
    private val throttle = Throttle(1_000)
    private var sendPending = false
    private val sendLater = Runnable { send() }

    override fun start() {
        light?.let { manager?.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL, handler) }
        proximity?.let { manager?.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL, handler) }
        if (light == null && proximity == null) publishIfChanged(ShellEvents.sensor(null, null))
    }

    override fun stop() {
        manager?.unregisterListener(this)
        handler.removeCallbacks(sendLater)
        sendPending = false
    }

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_LIGHT -> {
                val value = ShellEvents.roundLux(event.values[0])
                if (value == lux) return
                lux = value
                if (sendPending) return // the pending send picks up the newest value
                val wait = throttle.delayFor(SystemClock.elapsedRealtime())
                if (wait == 0L) {
                    send()
                } else {
                    sendPending = true
                    handler.postDelayed(sendLater, wait)
                }
            }
            Sensor.TYPE_PROXIMITY -> {
                val value = ShellEvents.isNear(event.values[0], event.sensor.maximumRange)
                if (value == near) return
                near = value
                handler.removeCallbacks(sendLater)
                send() // proximity is never delayed: it wakes the face
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun send() {
        sendPending = false
        throttle.markSent(SystemClock.elapsedRealtime())
        publishIfChanged(ShellEvents.sensor(lux, near))
    }
}

/** "power": battery level, temperature, charging, plugged. On change and every 60 s. */
class PowerFeed(private val context: Context, private val handler: Handler, emit: Emit) :
    Feed(ShellEvents.POWER, emit) {

    private var registered = false

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) = update(intent)
    }

    private val periodic = object : Runnable {
        override fun run() {
            last?.let { publish(it) }
            handler.postDelayed(this, PERIOD_MS)
        }
    }

    override fun start() {
        // ACTION_BATTERY_CHANGED is sticky: registering returns the current state at once.
        context.registerSystemReceiver(receiver, IntentFilter(Intent.ACTION_BATTERY_CHANGED))?.let { update(it) }
        registered = true
        handler.postDelayed(periodic, PERIOD_MS)
    }

    override fun stop() {
        if (registered) context.unregisterReceiver(receiver)
        registered = false
        handler.removeCallbacks(periodic)
    }

    private fun update(intent: Intent) {
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        publishIfChanged(
            ShellEvents.powerFromBattery(
                level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, 0),
                scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100),
                tenthsC = intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0),
                // The charge guard pauses charging while plugged in: plugged=true, charging=false.
                charging = status == BatteryManager.BATTERY_STATUS_CHARGING,
                plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0,
            ),
        )
    }

    private companion object {
        const val PERIOD_MS = 60_000L
    }
}

/**
 * "net": is a Wi-Fi network connected, and its RSSI. Wi-Fi up/down is sent at once;
 * RSSI-only changes at most once per 10 s, because Android reports RSSI every few seconds.
 */
class NetFeed(context: Context, private val handler: Handler, emit: Emit) : Feed(ShellEvents.NET, emit) {
    private val app = context.applicationContext
    private val connectivity = app.getSystemService(ConnectivityManager::class.java)
    private val wifiManager = app.getSystemService(WifiManager::class.java)

    private val wifiNetworks = HashSet<Network>()
    private var rssi: Int? = null
    private var running = false
    private val throttle = Throttle(10_000)
    private var sendPending = false
    private val sendLater = Runnable { sendPending = false; send() }
    private val firstReport = Runnable { send() }

    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            wifiNetworks += network
            rssi = readRssi()
            send()
        }

        override fun onLost(network: Network) {
            wifiNetworks -= network
            send()
        }
    }

    private val rssiReceiver = object : BroadcastReceiver() {
        override fun onReceive(c: Context, intent: Intent) {
            val value = ShellEvents.normalizeRssi(intent.getIntExtra(WifiManager.EXTRA_NEW_RSSI, -127))
            if (value == rssi) return
            rssi = value
            if (sendPending) return
            val wait = throttle.delayFor(SystemClock.elapsedRealtime())
            if (wait == 0L) {
                send()
            } else {
                sendPending = true
                handler.postDelayed(sendLater, wait)
            }
        }
    }

    override fun start() {
        val request = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
        // onAvailable fires right away for an already connected network.
        connectivity?.registerNetworkCallback(request, callback, handler)
        @Suppress("DEPRECATION") // RSSI_CHANGED_ACTION is the API-27 way to follow signal strength.
        app.registerSystemReceiver(rssiReceiver, IntentFilter(WifiManager.RSSI_CHANGED_ACTION))
        running = true
        // If no Wi-Fi shows up quickly, say so (the page may still think it is up).
        handler.postDelayed(firstReport, 1_500)
    }

    override fun stop() {
        if (!running) return
        running = false
        connectivity?.unregisterNetworkCallback(callback)
        app.unregisterReceiver(rssiReceiver)
        handler.removeCallbacks(sendLater)
        handler.removeCallbacks(firstReport)
        sendPending = false
        wifiNetworks.clear()
    }

    private fun send() {
        throttle.markSent(SystemClock.elapsedRealtime())
        publishIfChanged(ShellEvents.net(wifiNetworks.isNotEmpty(), rssi))
    }

    @Suppress("DEPRECATION") // connectionInfo is the API-27 way; it is all this device has.
    private fun readRssi(): Int? = wifiManager?.connectionInfo?.rssi?.let { ShellEvents.normalizeRssi(it) }
}
