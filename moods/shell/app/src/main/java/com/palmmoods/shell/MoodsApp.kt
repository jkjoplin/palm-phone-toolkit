package com.palmmoods.shell

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import kotlin.system.exitProcess

/**
 * Installs the crash handler: any uncaught exception records the crash, schedules
 * KioskActivity to start again and ends the process, so a bedside screen never sits on a
 * "Moods has stopped" dialog.
 *
 * Repeated crashes back off (see [CrashPolicy]). The system may relaunch the home app at
 * once, ahead of the alarm, so [KioskActivity] also reads [Crashes.startDelayMs] and waits
 * on a black screen before starting up. The system's own crash handler is never used: for
 * a home app that crashes repeatedly it clears the preferred-home setting.
 */
class MoodsApp : Application() {
    // Not delegating to the previous handler is deliberate: see the class comment.
    @SuppressLint("DefaultUncaughtExceptionDelegation")
    override fun onCreate() {
        super.onCreate()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                val delay = Crashes.record(this)
                Log.e(TAG, "Uncaught exception on ${thread.name}; restarting in $delay ms", error)
                Restart.schedule(this, delay, Restart.CRASH)
            } catch (t: Throwable) {
                // Could not schedule: still end the process ourselves. As the home app, the
                // system starts Moods again (KioskActivity then applies the back-off).
                try {
                    Log.e(TAG, "Uncaught exception on ${thread.name}; could not schedule a restart", error)
                } catch (_: Throwable) {
                }
            }
            Process.killProcess(Process.myPid())
            exitProcess(10)
        }
    }
}

/** Crash history, kept in private prefs so it survives the process. */
object Crashes {
    private const val PREFS = "crashes"
    private const val KEY = "times"

    private fun load(context: Context): List<Long> =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "").orEmpty()
            .split(',').mapNotNull { it.toLongOrNull() }

    /** Records a crash now and returns the restart delay. */
    fun record(context: Context): Long {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val earlier = load(context)
        val delay = CrashPolicy.restartDelayMs(earlier, now)
        // commit(), not apply(): the process is about to be killed.
        prefs.edit().putString(KEY, CrashPolicy.remember(earlier, now).joinToString(",")).commit()
        return delay
    }

    /** How long a new activity should wait before starting up (0 = no recent crash). */
    fun startDelayMs(context: Context): Long = CrashPolicy.startDelayMs(load(context), System.currentTimeMillis())
}

/** Alarms that bring KioskActivity back: after a crash, and after the escape hatch. */
object Restart {
    /** PendingIntent request codes: one alarm of each kind at a time. */
    const val CRASH = 0
    const val FROM_SETTINGS = 1

    private fun pending(context: Context, requestCode: Int, flags: Int): PendingIntent? {
        // NEW_TASK only: KioskActivity is singleTask, so an instance the system already
        // relaunched just gets onNewIntent instead of being torn down and built again.
        val intent = Intent(context, KioskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or flags)
    }

    @SuppressLint("MissingPermission") // setExact needs no permission below API 31, where it is used.
    fun schedule(context: Context, delayMs: Long, requestCode: Int, wakeup: Boolean = true) {
        val pi = pending(context, requestCode, PendingIntent.FLAG_CANCEL_CURRENT) ?: return
        val alarms = context.getSystemService(AlarmManager::class.java) ?: return
        val type = if (wakeup) AlarmManager.ELAPSED_REALTIME_WAKEUP else AlarmManager.ELAPSED_REALTIME
        val at = SystemClock.elapsedRealtime() + delayMs
        if (Build.VERSION.SDK_INT < 31) {
            alarms.setExact(type, at, pi)
        } else {
            alarms.set(type, at, pi) // exact alarms need a permission on 31+
        }
    }

    fun cancel(context: Context, requestCode: Int) {
        val pi = pending(context, requestCode, PendingIntent.FLAG_NO_CREATE) ?: return
        context.getSystemService(AlarmManager::class.java)?.cancel(pi)
        pi.cancel()
    }
}
