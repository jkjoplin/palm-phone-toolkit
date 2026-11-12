package com.palmmoods.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellEventsTest {

    @Test fun sensorKeepsNullKeys() {
        val p = ShellEvents.sensor(null, null)
        assertTrue(p.has("lux"))
        assertTrue(p.has("near"))
        assertTrue(p.isNull("lux"))
        val live = ShellEvents.sensor(12.5, true)
        assertEquals(12.5, live.getDouble("lux"), 1e-9)
        assertTrue(live.getBoolean("near"))
        assertEquals(2, live.length())
    }

    @Test fun netHidesRssiWhenOffline() {
        assertTrue(ShellEvents.net(false, -60).isNull("rssi"))
        assertEquals(-60, ShellEvents.net(true, -60).getInt("rssi"))
        assertTrue(ShellEvents.net(true, null).isNull("rssi"))
    }

    @Test fun powerFromBatteryExtras() {
        val p = ShellEvents.powerFromBattery(level = 46, scale = 100, tenthsC = 332, charging = false, plugged = true)
        assertEquals(46, p.getInt("level"))
        assertEquals(33.2, p.getDouble("tempC"), 1e-9)
        assertFalse(p.getBoolean("charging"))
        assertTrue(p.getBoolean("plugged"))
        assertEquals(50, ShellEvents.powerFromBattery(1, 2, 0, true, true).getInt("level"))
    }

    @Test fun lifecycleStates() {
        assertEquals("resume", ShellEvents.lifecycle(true).getString("state"))
        assertEquals("pause", ShellEvents.lifecycle(false).getString("state"))
    }

    @Test fun scriptGuardsMissingHandlerAndQuotesType() {
        val s = ShellEvents.script("sensor", JSONObject().put("lux", 3.0))
        assertTrue(s.contains("typeof f==='function'"))
        assertTrue(s.contains("f(\"sensor\",{\"lux\":3"))
        // A hostile type string cannot break out of the call.
        val evil = ShellEvents.script("x\");alert(1);(\"", JSONObject())
        assertTrue(evil.contains("f(\"x\\\");alert(1);(\\\"\","))
    }

    @Test fun luxRounding() {
        assertEquals(2.3, ShellEvents.roundLux(2.26f), 1e-9)
        assertEquals(0.0, ShellEvents.roundLux(0.04f), 1e-9)
    }

    @Test fun proximity() {
        assertTrue(ShellEvents.isNear(0f, 5f))
        assertFalse(ShellEvents.isNear(5f, 5f))
        assertTrue(ShellEvents.isNear(0f, 1f))
        assertFalse(ShellEvents.isNear(1f, 1f))
        assertFalse(ShellEvents.isNear(8f, 10f)) // continuous sensor: far beyond 5 cm
        assertTrue(ShellEvents.isNear(3f, 10f))
        assertTrue(ShellEvents.isNear(0f, 0f)) // broken range: fall back to 5 cm
    }

    @Test fun rssi() {
        assertNull(ShellEvents.normalizeRssi(-127))
        assertNull(ShellEvents.normalizeRssi(0))
        assertEquals(-69, ShellEvents.normalizeRssi(-69))
    }

    @Test fun throttleAllowsOncePerInterval() {
        val t = Throttle(1_000)
        assertEquals(0, t.delayFor(5_000))
        t.markSent(5_000)
        assertEquals(1_000, t.delayFor(5_000))
        assertEquals(600, t.delayFor(5_400))
        assertEquals(0, t.delayFor(6_000))
        assertEquals(0, t.delayFor(9_000))
        assertEquals(1_000, t.delayFor(4_000)) // clock went backwards: wait a full interval
    }
}
