package com.palmmoods.shell

import kotlin.math.roundToLong
import org.json.JSONObject

/**
 * Shell -> page events (contract section "Bridge: shell -> page").
 * Pure, so the exact payload shapes are tested on the JVM.
 *
 * Missing values are sent as JSON null, never left out: `JSONObject.put(k, null)`
 * would drop the key, so these use `JSONObject.NULL`.
 */
object ShellEvents {
    const val SENSOR = "sensor"
    const val POWER = "power"
    const val NET = "net"
    const val LIFECYCLE = "lifecycle"

    fun sensor(lux: Double?, near: Boolean?): JSONObject = JSONObject()
        .put("lux", lux ?: JSONObject.NULL)
        .put("near", near ?: JSONObject.NULL)

    fun power(level: Int, tempC: Double, charging: Boolean, plugged: Boolean): JSONObject = JSONObject()
        .put("level", level)
        .put("tempC", tempC)
        .put("charging", charging)
        .put("plugged", plugged)

    fun net(wifi: Boolean, rssi: Int?): JSONObject = JSONObject()
        .put("wifi", wifi)
        .put("rssi", if (wifi && rssi != null) rssi else JSONObject.NULL)

    fun lifecycle(resumed: Boolean): JSONObject = JSONObject()
        .put("state", if (resumed) "resume" else "pause")

    /**
     * The script passed to `evaluateJavascript`. It does nothing when the page has not
     * defined `window.__shell` (still loading, or a page that does not listen).
     */
    fun script(type: String, payload: JSONObject): String =
        "(function(){var f=window.__shell;if(typeof f==='function')f(${JSONObject.quote(type)},$payload);})();"

    /** Lux to one decimal, so sensor noise below 0.1 lux is not a "change". */
    fun roundLux(raw: Float): Double = (raw * 10.0).roundToLong() / 10.0

    /**
     * Proximity sensors report a distance in cm; most (the RPR0521 included) are binary and
     * report either 0 or their maximum range. "Near" = closer than 5 cm or the sensor's range.
     */
    fun isNear(distanceCm: Float, maxRangeCm: Float): Boolean {
        val threshold = if (maxRangeCm > 0f) minOf(maxRangeCm, 5f) else 5f
        return distanceCm < threshold
    }

    /** WifiManager reports -127 (or junk) when it has no reading. */
    fun normalizeRssi(raw: Int): Int? = if (raw in -126..-1) raw else null

    /** BatteryManager extras to the "power" payload. Temperature arrives in tenths of a degree. */
    fun powerFromBattery(level: Int, scale: Int, tenthsC: Int, charging: Boolean, plugged: Boolean): JSONObject {
        val percent = if (scale > 0) ((level * 100.0) / scale).roundToLong().toInt().coerceIn(0, 100) else level
        return power(percent, tenthsC / 10.0, charging, plugged)
    }
}

/**
 * "At most once per [intervalMs]". [delayFor] says how long to wait before the next send;
 * the caller sends the newest value when the wait ends, so the last change is never lost.
 * Not thread-safe: use it from one thread.
 */
class Throttle(private val intervalMs: Long) {
    private var lastSentAt: Long? = null

    fun delayFor(nowMs: Long): Long {
        val last = lastSentAt ?: return 0
        return (intervalMs - (nowMs - last)).coerceIn(0, intervalMs)
    }

    fun markSent(nowMs: Long) {
        lastSentAt = nowMs
    }

    fun reset() {
        lastSentAt = null
    }
}
