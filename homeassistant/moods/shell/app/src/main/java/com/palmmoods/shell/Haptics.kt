package com.palmmoods.shell

import android.content.Context
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log

/**
 * `Shell.haptic(kind)` on the vibrator. Uses only API 26 calls (createOneShot /
 * createWaveform at default amplitude), so it works on Android 8.1, which has no
 * predefined effects and no VibratorManager. Safe to call from any thread.
 */
class Haptics(context: Context) {
    private val vibrator: Vibrator? = context.applicationContext.getSystemService(Vibrator::class.java)

    fun play(kind: String?) {
        val timings = HapticPatterns.forKind(kind)
        if (timings == null) {
            Log.w(TAG, "Unknown haptic kind: $kind")
            return
        }
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        val effect = if (timings.size == 2) {
            VibrationEffect.createOneShot(timings[1], VibrationEffect.DEFAULT_AMPLITUDE)
        } else {
            VibrationEffect.createWaveform(timings, -1)
        }
        v.vibrate(effect)
    }
}
