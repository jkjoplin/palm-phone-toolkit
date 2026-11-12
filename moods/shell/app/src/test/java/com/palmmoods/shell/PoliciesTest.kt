package com.palmmoods.shell

import com.palmmoods.shell.HeartbeatWatchdog.Action
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PoliciesTest {

    @Test fun brightness() {
        assertEquals(Brightness.SYSTEM, Brightness.toWindow(-1.0))
        assertEquals(Brightness.MIN, Brightness.toWindow(0.0))
        assertEquals(Brightness.MIN, Brightness.toWindow(0.001))
        assertEquals(0.5f, Brightness.toWindow(0.5)!!, 1e-6f)
        assertEquals(1f, Brightness.toWindow(7.0)!!, 0f)
        assertNull(Brightness.toWindow(Double.NaN))
        assertNull(Brightness.toWindow(Double.POSITIVE_INFINITY))
    }

    @Test fun haptics() {
        assertArrayEquals(longArrayOf(0, 12), HapticPatterns.forKind("tick"))
        assertArrayEquals(longArrayOf(0, 30), HapticPatterns.forKind(" THUMP "))
        assertEquals(4, HapticPatterns.forKind("error")!!.size) // two buzzes
        assertNull(HapticPatterns.forKind("buzz"))
        assertNull(HapticPatterns.forKind(null))
    }

    @Test fun watchdogQuietWhileBeating() {
        val w = HeartbeatWatchdog(timeoutMs = 30_000)
        w.arm(0)
        for (t in 5_000L..120_000L step 5_000L) {
            w.beat(t)
            assertEquals(Action.NONE, w.check(t))
        }
    }

    @Test fun watchdogReloadsTwiceThenRebuilds() {
        val w = HeartbeatWatchdog(timeoutMs = 30_000)
        w.arm(0)
        assertEquals(Action.NONE, w.check(29_999))
        assertEquals(Action.RELOAD, w.check(30_000))
        assertEquals(Action.NONE, w.check(35_000)) // the reloaded page gets a full period
        assertEquals(Action.RELOAD, w.check(60_000))
        assertEquals(Action.REBUILD, w.check(90_000))
        // Three silent periods in a row: the period now doubles (60 s, 120 s, 240 s, then 5 min).
        assertEquals(Action.NONE, w.check(120_000))
        assertEquals(Action.RELOAD, w.check(150_000))
        assertEquals(Action.NONE, w.check(269_999))
        assertEquals(Action.RELOAD, w.check(270_000))
        assertEquals(Action.REBUILD, w.check(510_000))
        assertEquals(300_000, w.currentTimeoutMs())
        assertEquals(Action.NONE, w.check(809_999))
        assertEquals(Action.RELOAD, w.check(810_000))
        assertEquals(300_000, w.currentTimeoutMs()) // capped
    }

    @Test fun watchdogPageStartKeepsEscalation() {
        // Every reload starts a page, which calls arm(): that must not undo the escalation.
        val w = HeartbeatWatchdog(timeoutMs = 30_000)
        w.reset(0)
        assertEquals(Action.RELOAD, w.check(30_000))
        w.arm(30_500)
        assertEquals(Action.RELOAD, w.check(60_500))
        w.arm(61_000)
        assertEquals(Action.REBUILD, w.check(91_000))
    }

    @Test fun watchdogResetOnResumeForgetsEscalation() {
        val w = HeartbeatWatchdog(timeoutMs = 30_000)
        w.reset(0)
        assertEquals(Action.RELOAD, w.check(30_000))
        assertEquals(Action.RELOAD, w.check(60_000))
        w.disarm()
        w.reset(1_000_000) // screen off and on again
        assertEquals(Action.RELOAD, w.check(1_030_000)) // a reload, not straight to a rebuild
        assertEquals(30_000, w.currentTimeoutMs())
    }

    @Test fun watchdogBeatEndsBackoff() {
        val w = HeartbeatWatchdog(timeoutMs = 30_000)
        w.reset(0)
        assertEquals(Action.RELOAD, w.check(30_000))
        assertEquals(Action.RELOAD, w.check(60_000))
        assertEquals(Action.REBUILD, w.check(90_000))
        assertEquals(Action.RELOAD, w.check(150_000))
        assertEquals(120_000, w.currentTimeoutMs())
        w.beat(151_000)
        assertEquals(30_000, w.currentTimeoutMs())
        assertEquals(Action.RELOAD, w.check(181_000))
    }

    @Test fun webViewRetry() {
        assertEquals(10_000, WebViewRetry.delayMs(1))
        assertEquals(30_000, WebViewRetry.delayMs(2))
        assertEquals(60_000, WebViewRetry.delayMs(3))
        assertEquals(60_000, WebViewRetry.delayMs(50))
    }

    @Test fun watchdogBeatResetsEscalation() {
        val w = HeartbeatWatchdog(timeoutMs = 30_000)
        w.arm(0)
        assertEquals(Action.RELOAD, w.check(30_000))
        w.beat(31_000)
        assertEquals(Action.RELOAD, w.check(61_000))
        assertEquals(Action.RELOAD, w.check(91_000))
        assertEquals(Action.REBUILD, w.check(121_000))
    }

    @Test fun watchdogSleepsWhenDisarmed() {
        val w = HeartbeatWatchdog(timeoutMs = 30_000)
        w.arm(0)
        w.disarm()
        assertEquals(Action.NONE, w.check(10_000_000))
        w.arm(10_000_000) // resume restarts the clock
        assertEquals(Action.NONE, w.check(10_010_000))
    }

    @Test fun crashBackoff() {
        val now = 1_000_000L
        assertEquals(1_500, CrashPolicy.restartDelayMs(emptyList(), now))
        assertEquals(1_500, CrashPolicy.restartDelayMs(listOf(now - 10_000), now))
        assertEquals(15_000, CrashPolicy.restartDelayMs(listOf(now - 10_000, now - 5_000), now))
        assertEquals(120_000, CrashPolicy.restartDelayMs(List(5) { now - it * 1_000L }, now))
        assertEquals(1_500, CrashPolicy.restartDelayMs(List(9) { now - 70_000 }, now)) // old crashes forgotten
        assertEquals(listOf(now - 1_000, now), CrashPolicy.remember(listOf(now - 90_000, now - 1_000), now))
    }

    @Test fun crashStartDelay() {
        val crash = 1_000_000L
        assertEquals(0, CrashPolicy.startDelayMs(emptyList(), crash))
        // First crash: the system relaunched at once, so wait out the 1.5 s.
        assertEquals(1_500, CrashPolicy.startDelayMs(listOf(crash), crash))
        assertEquals(1_000, CrashPolicy.startDelayMs(listOf(crash), crash + 500))
        assertEquals(0, CrashPolicy.startDelayMs(listOf(crash), crash + 5_000)) // the alarm's own start
        // Third crash in a minute: 15 s.
        assertEquals(15_000, CrashPolicy.startDelayMs(listOf(crash - 20_000, crash - 10_000, crash), crash))
        // Sixth: 2 min.
        assertEquals(120_000, CrashPolicy.startDelayMs(List(6) { crash - it * 1_000L }, crash))
        // Old crash, or a crash "in the future" after a clock change: no wait.
        assertEquals(0, CrashPolicy.startDelayMs(listOf(crash), crash + 3_600_000))
        assertEquals(0, CrashPolicy.startDelayMs(listOf(crash + 3_600_000), crash))
    }
}
