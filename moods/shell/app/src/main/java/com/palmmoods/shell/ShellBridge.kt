package com.palmmoods.shell

import android.util.Log
import android.webkit.JavascriptInterface

const val TAG = "Moods"

/**
 * `window.Shell`: the page -> shell half of the bridge (contract section 1).
 *
 * WebView calls these on its JavaBridge thread, not the main thread, and every call is
 * synchronous for the page. Anything that touches the window or views is posted to the
 * main thread by the [Host].
 */
class ShellBridge(private val host: Host) {

    interface Host {
        fun configJson(): String
        fun setBrightness(level: Double)
        fun haptic(kind: String?)
        fun heartbeat()
        fun openSettings()
        fun reloadPage()
    }

    /** JSON, see [ShellConfig.toPageJson]. */
    @JavascriptInterface
    fun getConfig(): String = host.configJson()

    /** 0..1 window brightness (clamped to about 1/255); -1 returns to system brightness. */
    @JavascriptInterface
    fun setBrightness(level: Double) = host.setBrightness(level)

    /** "tick", "thump" or "error". */
    @JavascriptInterface
    fun haptic(kind: String?) = host.haptic(kind)

    /** The page calls this every 5 s; 30 s of silence reloads it. */
    @JavascriptInterface
    fun heartbeat() = host.heartbeat()

    /** Escape hatch: opens Android Settings. */
    @JavascriptInterface
    fun openSettings() = host.openSettings()

    @JavascriptInterface
    fun reload() = host.reloadPage()

    /** To logcat, tag "Moods". level: "debug", "info", "warn" or "error". */
    @JavascriptInterface
    fun log(level: String?, msg: String?) {
        val priority = when (level?.lowercase()) {
            "debug", "verbose" -> Log.DEBUG
            "warn", "warning" -> Log.WARN
            "error" -> Log.ERROR
            else -> Log.INFO
        }
        Log.println(priority, TAG, "page: " + (msg ?: "").take(4_000))
    }
}
