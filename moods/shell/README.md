# Moods shell (Android)

This is the Android half of Palm Moods. The app is a small Kotlin wrapper, built without Compose or AndroidX. It does four things:
- It turns an old phone into an always-on mood panel.
- It shows the bundled web UI (`../ui/`) in a fullscreen WebView.
- It gives that UI the hardware a web page cannot reach.
- It keeps the UI running.

The interface between the shell, the UI and Home Assistant is defined in [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md), section 1.

## Build

Requirements:
- JDK 17–21
- an Android SDK with platform 37 and build-tools 36+. Point `local.properties` (`sdk.dir=...`) or `ANDROID_HOME` at it.

```bash
cd shell
./gradlew testDebugUnitTest assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`, signed with the standard debug keystore (`~/.android/debug.keystore`).

On macOS with Homebrew's `openjdk@21` and Android command-line tools, for example:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21 ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
./gradlew --offline testDebugUnitTest assembleDebug
```

- **The UI is copied in at build time.** The `copyUiAssets` task syncs `../ui/` into the APK as `assets/ui/`, and the app loads `file:///android_asset/ui/index.html`. `ui/dev/` (the fake Home Assistant, test tools and their screenshots) is left out and is not even a task input, so the APK carries only the page, its scripts and the fonts (about 1.5 MB in all). The UI has no build step of its own. Edit `ui/`, rebuild, and reinstall. To check what ships: `unzip -l app/build/outputs/apk/debug/app-debug.apk | grep assets/`.
- **Installing on a phone:** use `../tools/provision.sh`, which also pushes the config and sets up the phone. To update just the app: `adb install -r app/build/outputs/apk/debug/app-debug.apk`.
- **Inspecting the page:** debug builds enable WebView remote debugging. Open `chrome://inspect` on a computer connected to the phone over adb.
- **The panels run the debug build.** It is debuggable and has WebView remote debugging on, so anyone with adb can read the token (`run-as`, `chrome://inspect`). On a rooted phone adb is already root, so this adds little; a release signing config can come later.

## What it does

| Area | Behaviour |
| --- | --- |
| Activity | `KioskActivity` is the only activity. It is both LAUNCHER and HOME, so it starts at boot once it is set as the home app. Portrait, immersive-sticky, keep-screen-on, shows over the keyguard and dismisses it. It does not turn the screen on by itself, so a restart at night leaves a screen that was turned off dark. Back does nothing. |
| WebView | JS and DOM storage on, media without a gesture, text zoom 100, no overscroll, no long-press/selection, black background. Navigation away from `file:///android_asset/ui/` is blocked. `console.*` goes to logcat under the tag `Moods`. |
| Wi-Fi | Holds a `WIFI_MODE_FULL_HIGH_PERF` lock while resumed, which keeps the HA socket responsive. |
| Config | At start, on every resume and on a new intent, imports `/sdcard/Android/data/com.palmmoods.shell/files/config.json` into private prefs and deletes the file, then reloads the page if the config changed. A file that is rejected (malformed, over 64 KiB) or cannot be saved is wiped and deleted too, and the old config is kept: the token never stays on shared storage. A leftover `config.json.bad` from an older build is deleted. With no config, the app reports `mock: true`. |
| Config log lines | `tools/provision.sh` decides success from these, so keep them stable: `Imported config: ...` (new config in use), `Config unchanged: ...` (same as stored; also success), `Rejected config.json: <reason>`, and `Recent crash: starting up in <ms> ms` (the import waits for the crash back-off). None of them contains the token. |
| Recovery | **Renderer gone:** rebuild the WebView, waiting 10 s after 3 deaths in a minute. **WebView cannot be built** (e.g. the WebView package is being updated): black screen, retry after 10 s, 30 s, then every 60 s. **No `Shell.heartbeat()` while resumed:** silent periods 1 and 2 reload the page, every third rebuilds the WebView; after three silent periods in a row the period doubles from 30 s up to 5 min. A heartbeat or a resume resets it. **Uncaught exception:** restart the activity after 1.5 s, backing off to 15 s and then 2 min in a crash loop. The system may relaunch the home app sooner, so a new activity also waits out the back-off on a black screen before it starts anything. |
| Escape hatch | `Shell.openSettings()` opens Android Settings. Home always returns to Moods; if nobody presses it, Moods comes back by itself after 5 min (the alarm does not wake the phone, so a screen that timed out in Settings shows Moods when it is next woken). |
| Brightness | Window brightness. The shell clamps it to at least 1/255; `-1` means system brightness. |
| Haptics | `VibrationEffect` one-shots and waveforms, API 26+. tick 12 ms, thump 30 ms, error 20+70+20 ms. Tune in `Policies.kt`. |
| Sensors | `TYPE_LIGHT` and `TYPE_PROXIMITY` (the RPR0521 on the Palm), registered only while resumed. Lux is rounded to 0.1 and sent at most once per second. Proximity is sent at once. |
| Power | `ACTION_BATTERY_CHANGED`: sent on change and re-sent every 60 s. `charging` means current is flowing into the battery, so with the charge guard paused it is `plugged: true, charging: false`. |
| Net | Wi-Fi up/down is sent at once. RSSI-only changes are sent at most once per 10 s, because Android reports RSSI every few seconds. |
| Lifecycle | `resume` / `pause`. After every page load, the latest sensor, power, net and lifecycle state is re-sent, so a reloaded page is never blank. |

On pause the shell does **not** pause the page's JavaScript timers. The UI keeps its Home Assistant socket open, so the first tap after the screen wakes is fast. The watchdog does not count time spent paused.

### Notes for the UI

- The page is loaded from `file://`. Classic `<script src>` and `@font-face` with relative URLs work: both were checked on a PVG100 (see "On a device"). `<script type="module">`, `fetch()` and XHR to local files are expected to fail, because Chromium blocks them for `file://` origins and file access from file URLs is left off on purpose. That failure was not tried on a device. The UI uses only classic scripts.
- Define `window.__shell(type, payload)` in `<head>`, before `DOMContentLoaded`.
- Start the `Shell.heartbeat()` interval (every 5 s) first thing in the script, before connecting to HA or anything else that can fail, and keep it running whatever the connection state. Otherwise the page is reloaded after 30 s, and again with back-off.
- Never `console.log` or `Shell.log` the config or the token: both go to logcat under the tag `Moods`, which `provision.sh` prints.
- No iframes or remote content: `window.Shell` (and so `getConfig()` with the token) is visible to every frame.
- Repeated identical events are normal: the latest sensor, power, net and lifecycle events are re-sent after every page load, and `power` every 60 s. Expect a pause/resume pair whenever the shell is started with an intent (Home, a restart alarm, provisioning).

## Testing the bridge and recovery on a phone

Debug builds carry a bridge test page (`app/src/debug/assets/ui/_bridge/index.html`, not in `../ui/`). It shows the config (token masked), live events, and a button for every `Shell` call, edge cases included.

```bash
adb shell am start -n com.palmmoods.shell/.KioskActivity --es page bridge   # show it
adb shell am start -n com.palmmoods.shell/.KioskActivity --es page ui       # back to the UI
```

| Path | How to trigger it |
| --- | --- |
| Watchdog reload, rebuild, back-off | On the bridge page, turn "auto heartbeat" off. The setting survives reloads, so you see reload, reload, rebuild, then longer gaps in `adb logcat -s Moods`. |
| Crash restart and back-off | `adb shell am crash <pid>` with the app's pid from `adb shell pidof com.palmmoods.shell`. Crashing by package name (`am crash com.palmmoods.shell`) hits the WebView renderer instead on the Palm, which runs as a sandboxed process of this package, so it only tests renderer death. The first two crashes in a minute restart after 1.5 s, the third and fourth after 15 s (checked on phone B: the system relaunches the activity at once and it waits out the back-off on a black screen). By the code, the sixth waits 2 min. |
| Renderer death | Kill the WebView renderer as root: find its pid with `adb shell ps -A \| grep sandboxed` (on the Palm, with Chrome as the WebView provider, `ps` shows `com.android.chrome:sandboxed` and the full name is `com.android.chrome:sandboxed_process<N>`, with N counting up), then `adb shell su -c 'kill -9 <pid>'`. |
| Escape hatch return | Tap "openSettings", leave the phone alone for 5 min, then wake it. |

## Tests

`./gradlew testDebugUnitTest` runs JVM tests for the config rules, event payloads and policies. `ShellConfigTest` also runs the shared cases in `../tools/config-cases.json`, which `../tools/test_check_config.py` runs against `provision.sh`'s check, so the two accept and reject the same files.

The JVM tests use Maven's `org.json`; the phone uses Android's own copy, which differs in places (key order, for one). The parser that ships is not covered by these tests. As a cheap on-device check, every import re-reads the stored config with the real parser and logs `Stored config reads back differently` if it does not match. A Robolectric or instrumented test of `parse()`, `toStoredJson()` and `toPageJson()` can come later.

## Layout

```
app/src/main/java/com/palmmoods/shell/
  KioskActivity.kt   window, WebView, recovery, shell -> page events
  ShellBridge.kt     window.Shell (@JavascriptInterface)
  ConfigStore.kt     config.json import -> private prefs
  Feeds.kt           sensor / power / net event sources
  Haptics.kt         vibrator
  MoodsApp.kt        crash -> restart
  ShellConfig.kt     config parsing and validation (pure, tested)
  ShellEvents.kt     payload shapes, throttle (pure, tested)
  Policies.kt        brightness clamp, haptic patterns, heartbeat watchdog, crash backoff (pure, tested)
app/src/test/...     JVM unit tests, run by testDebugUnitTest
```

## On a device

### Checked on a PVG100

On a US PVG100 (Android 8.1, firmware v3C3M, Chrome 101 WebView), with the app not yet set as the home app:

- `file://` loading: classic scripts and the bundled fonts load (`document.fonts` reports Fraunces loaded); the page sees 360x640 CSS px at DPR 2.
- The brightness floor: `setBrightness(0)` gives backlight 1 of 255. The system itself eases window-brightness changes (about 150 levels a second), on top of the UI's four steps.
- Proximity and light: the RPR0521's light and proximity sensors register while resumed and unregister on pause (`dumpsys sensorservice`). Proximity reads 5 (far) or 0 (near).
- Config: an adb push to the external files dir, the import, and the delete all work on 8.1's sdcardfs.
- Recovery: renderer death rebuilds the WebView. A stopped heartbeat reloads the page after 30 s. Four crashes in a minute restarted after 1.5 s, 1.5 s, 15 s and 15 s. The system relaunches the activity at once, and it waits out the back-off on a black screen.
- The escape-hatch return alarm brings Moods back after 5 min.

### Not yet verified

- How the 12 ms tick feels on the Palm's motor.
- Keyguard dismissal, and boot as the home app.
- localStorage for the bridge page on `file://`.
- That `<script type="module">`, `fetch()` and XHR of local files really fail on `file://`. The UI does not use them.
