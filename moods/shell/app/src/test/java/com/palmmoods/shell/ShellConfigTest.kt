package com.palmmoods.shell

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ShellConfigTest {

    private val full = """
        {"haUrl":"ws://192.168.1.10:8123/api/websocket","token":"abc.def",
         "panel":"bedroom","deviceName":"palm-bedroom","nightStart":"22:00","nightEnd":"07:00"}
    """.trimIndent()

    @Test fun fullConfigIsNotMock() {
        val c = ShellConfig.parse(full)
        assertFalse(c.mock)
        assertEquals("ws://192.168.1.10:8123/api/websocket", c.haUrl)
        assertEquals("bedroom", c.panel)
    }

    @Test fun pageJsonHasEveryContractKey() {
        val page = JSONObject(ShellConfig.parse(full).toPageJson("0.1.0"))
        for (key in listOf("mock", "haUrl", "token", "panel", "deviceName", "nightStart", "nightEnd", "appVersion")) {
            assertTrue("missing $key", page.has(key))
        }
        assertEquals(false, page.getBoolean("mock"))
        assertEquals("abc.def", page.getString("token"))
        assertEquals("0.1.0", page.getString("appVersion"))
    }

    @Test fun noConfigIsMockWithEmptyStrings() {
        val page = JSONObject(ShellConfig.NONE.toPageJson("0.1.0"))
        assertTrue(page.getBoolean("mock"))
        assertEquals("", page.getString("haUrl"))
        assertEquals("", page.getString("token"))
        assertEquals("22:00", page.getString("nightStart"))
        assertEquals("07:00", page.getString("nightEnd"))
    }

    @Test fun missingTokenIsMock() {
        assertTrue(ShellConfig.parse("""{"haUrl":"ws://h:8123/api/websocket"}""").mock)
        assertTrue(ShellConfig.parse("""{"haUrl":"ws://h:8123/api/websocket","token":"  "}""").mock)
    }

    @Test fun mockFlagForcesDemo() {
        val c = ShellConfig.parse(full.replace("{", """{"mock":true,"""))
        assertTrue(c.mock)
        assertTrue(ShellConfig.parse(c.toStoredJson()).mock)
    }

    @Test fun defaultsFollowPanel() {
        val c = ShellConfig.parse("""{"panel":"kitchen"}""")
        assertEquals("palm-kitchen", c.deviceName)
        assertEquals("22:00", c.nightStart)
    }

    @Test fun storedJsonRoundTrips() {
        val c = ShellConfig.parse(full.replace("{", """{"future":{"x":[1,2]},"""))
        val again = ShellConfig.parse(c.toStoredJson())
        assertEquals(c.copy(extras = emptyMap()), again.copy(extras = emptyMap()))
        assertEquals(c.extras.keys, again.extras.keys)
    }

    @Test fun unknownKeysPassThroughToPage() {
        val c = ShellConfig.parse("""{"haUrl":"ws://h:1/api/websocket","token":"t","dimFloor":0.02}""")
        val page = JSONObject(c.toPageJson("1"))
        assertEquals(0.02, page.getDouble("dimFloor"), 1e-9)
    }

    @Test fun appVersionInFileIsIgnored() {
        val page = JSONObject(ShellConfig.parse("""{"appVersion":"9.9"}""").toPageJson("0.1.0"))
        assertEquals("0.1.0", page.getString("appVersion"))
    }

    @Test fun normalizesHaUrls() {
        assertEquals("ws://192.168.1.10:8123/api/websocket", ShellConfig.normalizeHaUrl("http://192.168.1.10:8123"))
        assertEquals("ws://192.168.1.10:8123/api/websocket", ShellConfig.normalizeHaUrl(" http://192.168.1.10:8123/ "))
        assertEquals("wss://ha.example.ts.net/api/websocket", ShellConfig.normalizeHaUrl("https://ha.example.ts.net"))
        assertEquals("ws://h:8123/api/websocket", ShellConfig.normalizeHaUrl("ws://h:8123/api/websocket"))
        assertEquals("ws://192.168.1.10:8123/api/websocket", ShellConfig.normalizeHaUrl("http://192.168.1.10:8123/lovelace/0"))
        assertNull(ShellConfig.normalizeHaUrl("WS://h:8123/custom")) // a ws:// path that cannot be HA's
        assertNull(ShellConfig.normalizeHaUrl("192.168.1.10:8123"))
        assertNull(ShellConfig.normalizeHaUrl("ftp://h"))
        assertNull(ShellConfig.normalizeHaUrl("ws://user:pw@h:8123"))
    }

    @Test fun normalizesClockTimes() {
        assertEquals("07:00", ShellConfig.normalizeClock("7:00"))
        assertEquals("23:59", ShellConfig.normalizeClock("23:59"))
        assertNull(ShellConfig.normalizeClock("24:00"))
        assertNull(ShellConfig.normalizeClock("7pm"))
    }

    @Test fun rejectsMalformedValues() {
        for (bad in listOf(
            "not json",
            "[1,2]",
            """{"haUrl":"homeassistant.local"}""",
            """{"token":42}""",
            """{"nightStart":"25:00"}""",
            """{"mock":"yes"}""",
        )) {
            try {
                ShellConfig.parse(bad)
                fail("accepted $bad")
            } catch (e: ShellConfig.Invalid) {
                // expected
            }
        }
    }

    @Test fun rejectionNeverQuotesTheToken() {
        try {
            ShellConfig.parse("""{"token":"SECRET-123","nightEnd":"nope"}""")
            fail("accepted")
        } catch (e: ShellConfig.Invalid) {
            assertFalse(e.message!!.contains("SECRET"))
        }
    }

    /** tools/config-cases.json: the same cases run against provision.sh's check (tools/check_config.py). */
    @Test fun sharedCasesMatchProvisionCheck() {
        val path = System.getProperty("configCases") ?: "../../tools/config-cases.json"
        val data = JSONObject(File(path).readText())
        val base = data.getJSONObject("base")
        val cases = data.getJSONArray("cases")
        assertTrue(cases.length() > 20)
        val failures = mutableListOf<String>()
        for (i in 0 until cases.length()) {
            val case = cases.getJSONObject(i)
            val merged = JSONObject(base.toString())
            val over = case.getJSONObject("config")
            for (k in over.keys()) merged.put(k, over.get(k))
            val name = case.getString("name")
            try {
                val c = ShellConfig.parse(merged.toString())
                if (!case.getBoolean("ok")) failures += "$name: accepted"
                else if (case.has("haUrl") && c.haUrl != case.getString("haUrl")) failures += "$name: haUrl ${c.haUrl}"
            } catch (e: ShellConfig.Invalid) {
                if (case.getBoolean("ok")) failures += "$name: rejected (${e.message})"
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test fun describeMasksToken() {
        val text = ShellConfig.parse(full).describe()
        assertFalse(text.contains("abc.def"))
        assertTrue(text.contains("token=set(7)"))
    }
}
