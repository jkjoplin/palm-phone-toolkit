package com.palmmoods.shell

import android.content.Context
import android.util.Log
import java.io.File

/**
 * Keeps the [ShellConfig] in private SharedPreferences.
 *
 * Provisioning pushes `config.json` to the app's external files dir
 * (`/sdcard/Android/data/com.palmmoods.shell/files/config.json`). [importPending] moves
 * it into prefs and removes the file, so the token does not stay on shared storage.
 *
 * Whatever happens, the file does not stay there: a file that is rejected (malformed,
 * too big) or that cannot be saved is wiped and deleted too, and the previous config is
 * kept. Only the reason is logged, never the content.
 *
 * Log lines that tools/provision.sh looks for (keep them stable):
 * - `Imported config: ...`  a new config is in use
 * - `Config unchanged: ...` the file equals the stored config (also success)
 * - `Rejected config.json: <reason>`
 * - `Recent crash: starting up in <ms> ms` (KioskActivity; the import waits for it)
 */
class ConfigStore(context: Context) {
    enum class Import { NOTHING, IMPORTED, UNCHANGED, REJECTED }

    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences("moods", Context.MODE_PRIVATE)

    fun current(): ShellConfig {
        val stored = prefs.getString(KEY, null) ?: return ShellConfig.NONE
        return try {
            ShellConfig.parse(stored)
        } catch (e: ShellConfig.Invalid) {
            Log.e(TAG, "Stored config is unreadable (${e.message}); running as demo")
            ShellConfig.NONE
        }
    }

    fun importPending(): Import {
        val dir = app.getExternalFilesDir(null) ?: return Import.NOTHING
        // Older builds renamed rejected files to config.json.bad: never leave one around.
        File(dir, "$FILE_NAME.bad").takeIf { it.exists() }?.let { remove(it) }

        val file = File(dir, FILE_NAME)
        if (!file.isFile) return Import.NOTHING
        // A file that was wiped but could not be deleted last time: nothing to import.
        if (file.length() == 0L) {
            file.delete()
            return Import.NOTHING
        }

        val config = try {
            if (file.length() > MAX_BYTES) throw ShellConfig.Invalid("larger than $MAX_BYTES bytes")
            ShellConfig.parse(file.readText(Charsets.UTF_8))
        } catch (e: Exception) {
            val reason = if (e is ShellConfig.Invalid) e.message else e.javaClass.simpleName
            remove(file)
            Log.e(TAG, "Rejected $FILE_NAME: $reason. Kept the previous config; the file was deleted.")
            return Import.REJECTED
        }

        val storedJson = prefs.getString(KEY, null)
        val newJson = config.toStoredJson()
        if (storedJson == newJson) {
            remove(file)
            Log.i(TAG, "Config unchanged: ${config.describe()}")
            return Import.UNCHANGED
        }

        val saved = prefs.edit().putString(KEY, newJson).commit() ||
            prefs.edit().putString(KEY, newJson).commit()
        remove(file)
        if (!saved) {
            Log.e(TAG, "Rejected $FILE_NAME: could not save it to private storage. Kept the previous config; the file was deleted.")
            return Import.REJECTED
        }
        checkRoundTrip(config)
        Log.i(TAG, "Imported config: ${config.describe()}")
        return Import.IMPORTED
    }

    /**
     * The JVM tests use Maven's org.json; the phone uses Android's. Re-read what was just
     * stored with the real parser and say so loudly if it differs.
     */
    private fun checkRoundTrip(config: ShellConfig) {
        val back = current()
        if (back.copy(extras = emptyMap()) != config.copy(extras = emptyMap()) || back.extras.keys != config.extras.keys) {
            Log.e(TAG, "Stored config reads back differently: ${back.describe()}")
        }
    }

    /** Wipes the content first (in case delete fails on sdcardfs), then deletes. */
    private fun remove(file: File) {
        try {
            file.writeBytes(ByteArray(0))
        } catch (e: Exception) {
            Log.w(TAG, "Could not wipe ${file.name}: ${e.javaClass.simpleName}")
        }
        if (!file.delete() && file.exists()) Log.e(TAG, "Could not delete ${file.path}; it was wiped")
    }

    companion object {
        const val FILE_NAME = "config.json"
        private const val KEY = "config"
        private const val MAX_BYTES = 64 * 1024L
    }
}
