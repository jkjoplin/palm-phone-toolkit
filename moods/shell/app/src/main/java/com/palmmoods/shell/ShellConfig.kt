package com.palmmoods.shell

import java.net.URI
import java.util.Locale
import org.json.JSONException
import org.json.JSONObject

/**
 * The per-phone settings: pushed once as config.json, kept in private prefs,
 * and handed to the page by `Shell.getConfig()`.
 *
 * Pure Kotlin + org.json, so it is tested on the JVM (see ShellConfigTest).
 *
 * Rules:
 * - Missing `haUrl` or `token` is fine: the UI runs its demo (`mock: true`).
 *   `"mock": true` in the file forces the demo even with a URL and token.
 * - A value that is present but malformed rejects the whole file, so a typo never
 *   silently replaces a working config.
 * - Keys the shell does not know are kept and passed through to the page, so the UI
 *   can grow new settings without a shell release.
 */
data class ShellConfig(
    val haUrl: String? = null,
    val token: String? = null,
    val panel: String = DEFAULT_PANEL,
    val deviceName: String = "palm-$panel",
    val nightStart: String = DEFAULT_NIGHT_START,
    val nightEnd: String = DEFAULT_NIGHT_END,
    val forceMock: Boolean = false,
    /** Unknown keys, values as org.json gives them (String, Number, Boolean, JSONObject, JSONArray). */
    val extras: Map<String, Any> = emptyMap(),
) {
    /** No usable Home Assistant connection: the UI should run its demo. */
    val mock: Boolean get() = forceMock || haUrl == null || token == null

    /** What `Shell.getConfig()` returns. Strings are never null; empty means "not set". */
    fun toPageJson(appVersion: String): String {
        val o = JSONObject()
        for ((k, v) in extras) o.put(k, v)
        o.put("mock", mock)
        o.put("haUrl", haUrl ?: "")
        o.put("token", token ?: "")
        o.put("panel", panel)
        o.put("deviceName", deviceName)
        o.put("nightStart", nightStart)
        o.put("nightEnd", nightEnd)
        o.put("appVersion", appVersion)
        return o.toString()
    }

    /** What is kept in prefs. `parse(toStoredJson())` gives back an equal config. */
    fun toStoredJson(): String {
        val o = JSONObject()
        for ((k, v) in extras) o.put(k, v)
        haUrl?.let { o.put("haUrl", it) }
        token?.let { o.put("token", it) }
        o.put("panel", panel)
        o.put("deviceName", deviceName)
        o.put("nightStart", nightStart)
        o.put("nightEnd", nightEnd)
        if (forceMock) o.put("mock", true)
        return o.toString()
    }

    /** Safe for logs: never contains the token. */
    fun describe(): String =
        "mock=$mock haUrl=${haUrl ?: "-"} token=${if (token == null) "-" else "set(${token.length})"} " +
            "panel=$panel device=$deviceName night=$nightStart-$nightEnd extras=${extras.keys.sorted()}"

    class Invalid(message: String) : Exception(message)

    companion object {
        const val DEFAULT_PANEL = "default"
        const val DEFAULT_NIGHT_START = "22:00"
        const val DEFAULT_NIGHT_END = "07:00"

        /** No config at all: demo mode. */
        val NONE = ShellConfig()

        /** Keys the shell owns. `appVersion` is ignored if a file carries it. */
        private val KNOWN = setOf(
            "haUrl", "token", "panel", "deviceName", "nightStart", "nightEnd", "mock", "appVersion",
        )

        /** Parses config.json text. Throws [Invalid] with a reason that never includes the token. */
        fun parse(text: String): ShellConfig {
            val o = try {
                JSONObject(text)
            } catch (e: JSONException) {
                throw Invalid("not a JSON object")
            }

            val haUrl = optString(o, "haUrl")?.let {
                normalizeHaUrl(it) ?: throw Invalid("haUrl is not a ws://, wss://, http:// or https:// URL with a host")
            }
            val token = optString(o, "token")
            val panel = optString(o, "panel") ?: DEFAULT_PANEL
            val deviceName = optString(o, "deviceName") ?: "palm-$panel"
            val nightStart = optString(o, "nightStart")?.let {
                normalizeClock(it) ?: throw Invalid("nightStart must be HH:MM (24 h)")
            } ?: DEFAULT_NIGHT_START
            val nightEnd = optString(o, "nightEnd")?.let {
                normalizeClock(it) ?: throw Invalid("nightEnd must be HH:MM (24 h)")
            } ?: DEFAULT_NIGHT_END
            val forceMock = when (val m = o.opt("mock")) {
                null, JSONObject.NULL -> false
                is Boolean -> m
                else -> throw Invalid("mock must be true or false")
            }

            val extras = LinkedHashMap<String, Any>()
            for (key in o.keys()) {
                if (key in KNOWN) continue
                val v = o.get(key)
                if (v != JSONObject.NULL) extras[key] = v
            }
            return ShellConfig(haUrl, token, panel, deviceName, nightStart, nightEnd, forceMock, extras)
        }

        /** A trimmed non-blank string, null when absent/null/blank. Wrong type rejects the file. */
        private fun optString(o: JSONObject, key: String): String? {
            val v = o.opt(key) ?: return null
            if (v == JSONObject.NULL) return null
            if (v !is String) throw Invalid("$key must be a string")
            return v.trim().ifEmpty { null }
        }

        private const val WS_PATH = "/api/websocket"

        /**
         * Accepts what people actually paste and returns the WebSocket URL:
         * - `ws://192.168.1.10:8123/api/websocket` stays as is
         * - `http://192.168.1.10:8123`, with or without a path (e.g. `/lovelace/0` copied from
         *   a browser), becomes `ws://192.168.1.10:8123/api/websocket`
         * - `https://...` becomes `wss://...`
         * - a path that already ends in `/api/websocket` is kept (HA behind a sub-path proxy)
         * - any query is dropped
         * Returns null when it cannot be a Home Assistant URL: another scheme, no host
         * (java.net.URI also gives none for `_` in a name, a last label starting with a digit,
         * or a non-numeric port), a port outside 1..65535, user info, a fragment, or a
         * `ws(s)://` path other than empty, `/` or `.../api/websocket`.
         * tools/check_config.py mirrors these rules (shared cases: tools/config-cases.json).
         */
        fun normalizeHaUrl(raw: String): String? {
            val uri = try {
                URI(raw.trim())
            } catch (e: Exception) {
                return null
            }
            val given = uri.scheme?.lowercase()
            val web = when (given) {
                "http", "https" -> true
                "ws", "wss" -> false
                else -> return null
            }
            val scheme = if (given == "https" || given == "wss") "wss" else "ws"
            val host = uri.host ?: return null
            if (uri.rawUserInfo != null || uri.rawFragment != null) return null
            if (uri.port != -1 && uri.port !in 1..65535) return null
            val rawPath = uri.rawPath.orEmpty()
            val path = when {
                rawPath.endsWith(WS_PATH) -> rawPath
                web || rawPath.isEmpty() || rawPath == "/" -> WS_PATH
                else -> return null
            }
            val port = if (uri.port == -1) "" else ":${uri.port}"
            val hostPart = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
            // Any query is dropped: the HA WebSocket API takes none.
            return "$scheme://$hostPart$port$path"
        }

        private val CLOCK = Regex("""^(\d{1,2}):(\d{2})$""")

        /** "7:00" -> "07:00"; null unless it is a valid 24 h time. */
        fun normalizeClock(raw: String): String? {
            val m = CLOCK.matchEntire(raw.trim()) ?: return null
            val h = m.groupValues[1].toInt()
            val min = m.groupValues[2].toInt()
            if (h > 23 || min > 59) return null
            return String.format(Locale.ROOT, "%02d:%02d", h, min)
        }
    }
}
