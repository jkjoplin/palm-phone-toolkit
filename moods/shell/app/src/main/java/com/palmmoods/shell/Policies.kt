package com.palmmoods.shell

/*
 * Small decisions kept free of Android types so they are tested on the JVM.
 */

/** `Shell.setBrightness(level)` -> `WindowManager.LayoutParams.screenBrightness`. */
object Brightness {
    /** About one backlight step (1/255). Android may raise it to the device minimum. */
    const val MIN = 1f / 255f

    /** Same value as `WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE`: follow the system. */
    const val SYSTEM = -1f

    /** Negative = system brightness; 0..1 clamped to [MIN, 1]; NaN/infinite = ignore (null). */
    fun toWindow(level: Double): Float? = when {
        level.isNaN() || level.isInfinite() -> null
        level < 0 -> SYSTEM
        else -> level.toFloat().coerceIn(MIN, 1f)
    }
}

/**
 * Vibration timings for `Shell.haptic(kind)`, as `VibrationEffect.createWaveform` takes them:
 * off, on, off, on... in ms. Tune the feel here.
 */
object HapticPatterns {
    const val TICK_MS = 12L
    const val THUMP_MS = 30L

    fun forKind(kind: String?): LongArray? = when (kind?.trim()?.lowercase()) {
        "tick" -> longArrayOf(0, TICK_MS)
        "thump" -> longArrayOf(0, THUMP_MS)
        "error" -> longArrayOf(0, 20, 70, 20) // two short buzzes
        else -> null
    }
}

/**
 * Reloads a page that stopped calling `Shell.heartbeat()`.
 *
 * - [reset] on resume: armed, full period, escalation forgotten.
 * - [arm] when a page starts loading: restarts the clock only, so a watchdog reload does
 *   not wipe its own escalation.
 * - [disarm] on pause: a sleeping screen freezes page timers; that is not a hang.
 *
 * Silent periods 1 and 2 reload the page, every third rebuilds the whole WebView (for a
 * renderer that is stuck rather than dead). After [steadyPeriods] silent periods in a row
 * the period doubles, up to [maxTimeoutMs], so a page that never heartbeats does not
 * flash the bedside screen every 30 s all night. One heartbeat resets everything.
 *
 * [beat] may be called from the JavaBridge thread; the rest runs on the main thread.
 */
class HeartbeatWatchdog(
    val timeoutMs: Long = 30_000,
    private val reloadsBeforeRebuild: Int = 2,
    private val steadyPeriods: Int = 3,
    val maxTimeoutMs: Long = 300_000,
) {
    enum class Action { NONE, RELOAD, REBUILD }

    @Volatile private var lastBeatAt = 0L
    @Volatile private var armed = false
    @Volatile private var silentPeriods = 0

    /** Resume: arm with a full base period and forget any escalation. */
    fun reset(nowMs: Long) {
        silentPeriods = 0
        arm(nowMs)
    }

    /** A page started loading: restart the clock, keep the escalation. */
    fun arm(nowMs: Long) {
        lastBeatAt = nowMs
        armed = true
    }

    fun disarm() {
        armed = false
    }

    fun beat(nowMs: Long) {
        lastBeatAt = nowMs
        silentPeriods = 0
    }

    /** How long the page may now stay silent before the next action. */
    fun currentTimeoutMs(): Long {
        val doublings = (silentPeriods - steadyPeriods + 1).coerceIn(0, 30)
        return (timeoutMs shl doublings).coerceAtMost(maxTimeoutMs)
    }

    fun check(nowMs: Long): Action {
        if (!armed || nowMs - lastBeatAt < currentTimeoutMs()) return Action.NONE
        lastBeatAt = nowMs // give the reloaded page a full period
        silentPeriods++
        return if (silentPeriods % (reloadsBeforeRebuild + 1) == 0) Action.REBUILD else Action.RELOAD
    }
}

/** Delays before retrying a WebView that could not be built (e.g. its package is mid-update). */
object WebViewRetry {
    private val DELAYS_MS = longArrayOf(10_000, 30_000, 60_000)

    /** [failures] = consecutive failed builds, counting this one (1 = first failure). */
    fun delayMs(failures: Int): Long = DELAYS_MS[(failures - 1).coerceIn(0, DELAYS_MS.size - 1)]
}

/** How long to wait before restarting after a crash, so a crash loop does not spin. */
object CrashPolicy {
    const val WINDOW_MS = 60_000L

    /** [recentCrashes] = earlier crash times (ms), any order; the current crash is not included. */
    fun restartDelayMs(recentCrashes: List<Long>, nowMs: Long): Long {
        val inWindow = recentCrashes.count { nowMs - it in 0 until WINDOW_MS }
        return when {
            inWindow < 2 -> 1_500
            inWindow < 5 -> 15_000
            else -> 120_000
        }
    }

    /** Crash times worth keeping: the ones inside the window, plus now. */
    fun remember(recentCrashes: List<Long>, nowMs: Long): List<Long> =
        recentCrashes.filter { nowMs - it in 0 until WINDOW_MS } + nowMs

    /**
     * How long a freshly created activity should wait before starting up, given the
     * recorded crash times (the latest is the crash that led to this start).
     *
     * The system may relaunch a home app at once, ahead of the restart alarm; this keeps
     * the back-off in force on that path too. Clamped to 0..[MAX_DELAY_MS] so a clock
     * change cannot make it negative or huge.
     */
    fun startDelayMs(crashes: List<Long>, nowMs: Long): Long {
        val latest = crashes.maxOrNull() ?: return 0
        if (nowMs - latest !in 0 until WINDOW_MS) return 0
        val delay = restartDelayMs(crashes - latest, latest)
        return (latest + delay - nowMs).coerceIn(0, MAX_DELAY_MS)
    }

    const val MAX_DELAY_MS = 120_000L
}
