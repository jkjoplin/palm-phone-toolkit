package com.palmmoods.shell

import android.annotation.SuppressLint
import android.app.Activity
import android.app.KeyguardManager
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.window.OnBackInvokedDispatcher
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONObject

/**
 * The whole app: a fullscreen, always-on WebView showing the bundled UI, plus the
 * hardware the page cannot reach (contract section 1).
 *
 * Recovery, from cheapest to heaviest:
 * - the page stops calling `Shell.heartbeat()` for 30 s -> reload it (third time: rebuild the
 *   WebView), backing off to 5 min for a page that never heartbeats ([HeartbeatWatchdog]);
 * - the renderer dies, or a WebView cannot be built -> build one again ([buildWebView]);
 * - an uncaught exception -> the process restarts the activity ([MoodsApp]); after a crash,
 *   [onCreate] waits on a black screen for the back-off before starting up ([Crashes]).
 *
 * Only one path builds WebViews: [buildWebView], directly or through [scheduleBuild].
 */
class KioskActivity : Activity(), ShellBridge.Host {

    private val main = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout
    private var webView: WebView? = null

    private lateinit var configStore: ConfigStore
    private lateinit var haptics: Haptics
    private lateinit var feeds: List<Feed>
    private val watchdog = HeartbeatWatchdog()
    private var wifiLock: WifiManager.WifiLock? = null
    private var resumed = false
    /** False until [startUp] has run (it waits out a crash back-off first). */
    private var started = false
    private val rendererDeaths = ArrayDeque<Long>()
    private var buildFailures = 0
    /** The page being shown; [reloadPageNow] reloads this one. */
    private var pageUrl = START_URL

    private val startUp = Runnable { startUpNow() }
    private val buildNow = Runnable { buildWebView() }

    private val watchdogTick = object : Runnable {
        override fun run() {
            main.postDelayed(this, WATCHDOG_TICK_MS)
            // A build is pending (renderer gone, failed build): nothing to judge yet.
            if (webView == null) return
            val silentFor = watchdog.currentTimeoutMs()
            val action = watchdog.check(SystemClock.elapsedRealtime())
            if (action == HeartbeatWatchdog.Action.NONE) return
            val next = watchdog.currentTimeoutMs()
            val backoff = if (next > watchdog.timeoutMs) "; next check in ${next / 1000} s" else ""
            if (action == HeartbeatWatchdog.Action.RELOAD) {
                Log.w(TAG, "No heartbeat for ${silentFor / 1000} s; reloading the page$backoff")
                reloadPageNow()
            } else {
                Log.w(TAG, "Still no heartbeat after reloads; rebuilding the WebView$backoff")
                rebuildWebView()
            }
        }
    }

    // ---- lifecycle ----------------------------------------------------------------------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showOverKeyguard()
        consumeBackOnNewerAndroid()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Only constructors and the black window before the back-off gate: anything that
        // could be what crashed (config import, feeds, WebView) runs in startUpNow().
        configStore = ConfigStore(this)
        haptics = Haptics(this)
        feeds = listOf(
            SensorFeed(this, main, ::emit),
            PowerFeed(this, main, ::emit),
            NetFeed(this, main, ::emit),
        )
        wifiLock = createWifiLock()
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(root)
        debugPage(intent)?.let { pageUrl = it }

        val delay = try {
            Crashes.startDelayMs(this)
        } catch (e: Exception) {
            0L
        }
        if (delay > 0) {
            Log.w(TAG, "Recent crash: starting up in $delay ms")
            main.postDelayed(startUp, delay)
        } else {
            startUpNow()
        }
    }

    private fun startUpNow() {
        main.removeCallbacks(startUp)
        if (started || isDestroyed) return
        started = true
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        configStore.importPending()
        buildWebView()
        if (resumed) startRunning()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        enterImmersive()
        // Back in front: the escape-hatch return and any pending crash restart are moot.
        Restart.cancel(this, Restart.FROM_SETTINGS)
        Restart.cancel(this, Restart.CRASH)
        if (started) startRunning()
    }

    private fun startRunning() {
        // A config pushed while the app was already running (re-provisioning).
        if (configStore.importPending() == ConfigStore.Import.IMPORTED) reloadPageNow()
        wifiLock?.acquire()
        webView?.onResume()
        feeds.forEach { it.start() }
        watchdog.reset(SystemClock.elapsedRealtime())
        main.removeCallbacks(watchdogTick)
        main.postDelayed(watchdogTick, WATCHDOG_TICK_MS)
        emit(ShellEvents.LIFECYCLE, ShellEvents.lifecycle(resumed = true))
    }

    /** Home pressed, a restart alarm, or `am start` from provision.sh while already running. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val page = debugPage(intent)
        if (page != null && page != pageUrl) {
            pageUrl = page
            reloadPageNow()
        }
        if (started && configStore.importPending() == ConfigStore.Import.IMPORTED) reloadPageNow()
    }

    /**
     * Debug builds only: `adb shell am start -n com.palmmoods.shell/.KioskActivity --es page bridge`
     * shows the bridge test page (src/debug/assets/ui/_bridge/); `--es page ui` goes back.
     */
    private fun debugPage(intent: Intent?): String? {
        if (!BuildConfig.DEBUG) return null
        return when (intent?.getStringExtra("page")) {
            "bridge" -> BRIDGE_URL
            "ui" -> START_URL
            else -> null
        }
    }

    override fun onPause() {
        // Tell the page first, while it is still running.
        emit(ShellEvents.LIFECYCLE, ShellEvents.lifecycle(resumed = false))
        resumed = false
        // Page timers freeze while the screen sleeps; do not count that as a hang.
        watchdog.disarm()
        main.removeCallbacks(watchdogTick)
        feeds.forEach { it.stop() }
        wifiLock?.takeIf { it.isHeld }?.release()
        // Not pauseTimers(): the page keeps its Home Assistant socket warm for a fast wake.
        webView?.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        webView?.let { destroyWebView(it) }
        webView = null
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersive()
    }

    /** This is the home screen: Back has nowhere to go. API 33+ uses [consumeBackOnNewerAndroid]. */
    @Deprecated("Back is consumed; the page owns navigation.")
    @SuppressLint("GestureBackNavigation", "MissingSuperCall")
    override fun onBackPressed() = Unit

    private fun consumeBackOnNewerAndroid() {
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { }
        }
    }

    // ---- window ---------------------------------------------------------------------------

    /** No setTurnScreenOn: a restart must not light a screen someone turned off at night. */
    private fun showOverKeyguard() {
        setShowWhenLocked(true)
        getSystemService(KeyguardManager::class.java)?.requestDismissKeyguard(this, null)
    }

    @Suppress("DEPRECATION")
    private fun enterImmersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            // API 27-29: immersive-sticky via the old flags.
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
        }
    }

    @Suppress("DEPRECATION") // FULL_HIGH_PERF is deprecated on API 34+, and is what API 27 has.
    private fun createWifiLock(): WifiManager.WifiLock? =
        applicationContext.getSystemService(WifiManager::class.java)
            ?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Moods:kiosk")
            ?.apply { setReferenceCounted(false) }

    // ---- WebView --------------------------------------------------------------------------

    private fun scheduleBuild(delayMs: Long) {
        main.removeCallbacks(buildNow)
        main.postDelayed(buildNow, delayMs)
    }

    /**
     * The only place a WebView is made. Building can throw (the system WebView package is
     * missing or being updated): then the root stays black and it retries after 10 s,
     * 30 s, then every 60 s.
     */
    private fun buildWebView() {
        main.removeCallbacks(buildNow)
        if (isDestroyed || webView != null) return
        val wv = try {
            createWebView()
        } catch (t: Throwable) {
            buildFailures++
            val delay = WebViewRetry.delayMs(buildFailures)
            Log.e(TAG, "Could not build the WebView (attempt $buildFailures); retrying in ${delay / 1000} s", t)
            scheduleBuild(delay)
            return
        }
        buildFailures = 0
        webView = wv
        if (resumed) wv.onResume() else wv.onPause()
        wv.loadUrl(pageUrl)
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun createWebView(): WebView {
        var made: WebView? = null
        try {
            val wv = WebView(this)
            made = wv
            wv.setBackgroundColor(Color.BLACK)
            with(wv.settings) {
                javaScriptEnabled = true
                domStorageEnabled = true
                mediaPlaybackRequiresUserGesture = false
                textZoom = 100
                setSupportZoom(false)
                builtInZoomControls = false
                displayZoomControls = false
                // Only file:///android_asset/ is ever loaded, and asset access ignores this flag.
                // Keeping it off stops page script from reading the app's private files.
                allowFileAccess = false
                allowContentAccess = false
            }
            wv.overScrollMode = View.OVER_SCROLL_NEVER
            wv.isVerticalScrollBarEnabled = false
            wv.isHorizontalScrollBarEnabled = false
            // No long-press selection, context menu, or the system's long-press buzz.
            wv.isLongClickable = false
            wv.setOnLongClickListener { true }
            wv.isHapticFeedbackEnabled = false
            wv.addJavascriptInterface(ShellBridge(this), "Shell")
            wv.webViewClient = Client()
            wv.webChromeClient = Chrome()
            root.addView(wv, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            return wv
        } catch (t: Throwable) {
            made?.let {
                try {
                    root.removeView(it)
                    it.destroy()
                } catch (_: Throwable) {
                }
            }
            throw t
        }
    }

    /** [dead] = its renderer is gone: then only removing and destroying it is allowed. */
    private fun destroyWebView(wv: WebView, dead: Boolean = false) {
        root.removeView(wv)
        if (!dead) {
            wv.stopLoading()
            wv.webViewClient = WebViewClient()
            wv.removeJavascriptInterface("Shell")
        }
        wv.destroy()
    }

    private fun rebuildWebView() {
        webView?.let { destroyWebView(it) }
        webView = null
        buildWebView()
    }

    private fun reloadPageNow() {
        // loadUrl, not reload(): it also brings back a page that somehow navigated away.
        webView?.loadUrl(pageUrl)
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (url.startsWith(ASSET_ROOT)) return false
            Log.w(TAG, "Blocked navigation to $url")
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            if (resumed) watchdog.arm(SystemClock.elapsedRealtime())
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (view !== webView) return
            // A fresh page knows nothing yet: give it the latest of everything.
            feeds.forEach { feed -> feed.last?.let { emit(feed.type, it) } }
            emit(ShellEvents.LIFECYCLE, ShellEvents.lifecycle(resumed))
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) Log.e(TAG, "Page failed to load: ${error.errorCode} ${error.description}")
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.e(TAG, "WebView renderer gone (crashed=${detail.didCrash()}); rebuilding")
            // The dead WebView must not be touched again except to destroy it.
            if (view === webView) webView = null
            destroyWebView(view, dead = true)
            val now = SystemClock.elapsedRealtime()
            rendererDeaths.addLast(now)
            while (rendererDeaths.isNotEmpty() && now - rendererDeaths.first() > 60_000) rendererDeaths.removeFirst()
            // Three deaths in a minute: wait before trying again, rather than spin.
            val delay = if (rendererDeaths.size >= 3) 10_000L else 0L
            scheduleBuild(delay)
            return true
        }
    }

    private class Chrome : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            val priority = when (message.messageLevel()) {
                ConsoleMessage.MessageLevel.ERROR -> Log.ERROR
                ConsoleMessage.MessageLevel.WARNING -> Log.WARN
                ConsoleMessage.MessageLevel.DEBUG, ConsoleMessage.MessageLevel.TIP -> Log.DEBUG
                else -> Log.INFO
            }
            Log.println(priority, TAG, "console: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
            return true
        }
    }

    // ---- shell -> page --------------------------------------------------------------------

    /** Main thread only. Safe while the page is loading or has no `window.__shell`. */
    private fun emit(type: String, payload: JSONObject) {
        webView?.evaluateJavascript(ShellEvents.script(type, payload), null)
    }

    // ---- page -> shell (ShellBridge.Host; called on the JavaBridge thread) ------------------

    override fun configJson(): String = configStore.current().toPageJson(BuildConfig.VERSION_NAME)

    override fun setBrightness(level: Double) {
        val value = Brightness.toWindow(level) ?: return
        runOnUiThread {
            window.attributes = window.attributes.apply { screenBrightness = value }
        }
    }

    override fun haptic(kind: String?) = haptics.play(kind)

    override fun heartbeat() = watchdog.beat(SystemClock.elapsedRealtime())

    /**
     * Escape hatch. Home always comes back to Moods; if nobody presses it, Moods comes back
     * by itself after [SETTINGS_RETURN_MS] (cancelled in onResume). The alarm does not wake
     * the phone, so a screen that timed out in Settings shows Moods when it is next woken.
     */
    override fun openSettings() {
        runOnUiThread {
            try {
                startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                Restart.schedule(this, SETTINGS_RETURN_MS, Restart.FROM_SETTINGS, wakeup = false)
            } catch (e: ActivityNotFoundException) {
                Log.e(TAG, "No Settings activity", e)
            }
        }
    }

    override fun reloadPage() = runOnUiThread { reloadPageNow() }

    private companion object {
        const val ASSET_ROOT = "file:///android_asset/ui/"
        const val START_URL = ASSET_ROOT + "index.html"
        const val BRIDGE_URL = ASSET_ROOT + "_bridge/index.html"
        const val WATCHDOG_TICK_MS = 5_000L
        const val SETTINGS_RETURN_MS = 5 * 60_000L
    }
}
