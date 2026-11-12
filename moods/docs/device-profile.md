## Palm PVG100 kiosk capability profile

A read-only survey of two US PVG100 phones, done before Palm Moods was built. Phone A runs the 2019 firmware (v1AGN), phone B the 2021 firmware (v3C3M). Both were rooted with Magisk and ran the toolkit's charge limiter.

A phone that has been through Google setup can keep a `com.google.android.gms/...setupservices.GoogleServicesActivity` layer in its window stack, which can pop up over a kiosk.

### Capability table
| Topic | Phone A (2019 fw v1AGN, patch 2019-03) | Phone B (2021 fw v3C3M, patch 2021-04) |
|---|---|---|
| WebView provider | **Chrome 101.0.4951.61** (`dumpsys webviewupdate`; the standalone WebView v66 package is disabled) | same (WebView v70 disabled) |
| Chrome state | first-run done, `webapp_registry` empty (no PWAs/shortcuts yet) | same |
| Panel | **LCD**, FocalTech `ft8613 1280p video mode dsi`, WLED backlight. No burn-in risk; the backlight wears instead | same |
| Backlight node | `/sys/class/leds/lcd-backlight/brightness`, max 255; reading 13 (auto) | same; read 16 with the screen on, 0 after the timeout |
| Brightness range | Settings slider is capped at **135/255**. The auto-brightness curve reaches 255 | same cap; on B the auto curve is **capped at 135** above 8000 lux |
| Auto-brightness | on (mode=1); software auto, light-sensor spline | on |
| Refresh | 60 Hz, single mode; `dyn_fps_en=1` (35–60) | 60 Hz, `dyn_fps_en=0` |
| GPU | Adreno 505, GLES 3.2 V@269.0 (driver dated 2018) | same |
| CSS viewport | density override 272 → DPR 1.7 → ~424×717 app area / 424×753 full | DPR 2 → 360×604 app area / 360×640 full |
| System decor | status bar 41 px (24 dp), no NavigationBar window; app height 1219 | status bar 48 px, app height 1208 |
| screen_off_timeout | **2147483647 (never)** | **60000** (it was asleep on a keyguard during the checks) |
| stay_on_while_plugged_in | 0 | 0 |
| Keyguard | swipe only (no gatekeeper/password files, deviceLocked=0) | swipe only, showing now |
| Ambient display / doze | **none**: `getDozeComponent()=null`, doze_enabled=0 | same |
| Daydream | supported, disabled | same |
| Plug detection | reports `AC powered: true` (USB_CDP, 1.5 A max) even while charging is paused | `AC powered: true` (USB_CDP, 3 A advertised) |
| Sensors | RPR0521 proximity (**wake-up** sensor, on-change) + light (live 70–92 lux); Bosch BHI accel, gyro, significant motion, step | same; light 68–114 lux |
| RAM | 2.9 GB total, MemAvailable ~1.56 GB, swap 81 MB used | ~1.58 GB available, swap 345 MB used |
| CPU | 8× A53, governor `interactive`. Little cluster 0.96–1.40 GHz, big cluster capped 1.09 GHz; core_ctl offlines cores (online 0-1,4-7) | same (online 0,3-7) |
| GPU clock | msm-adreno-tz, max 475 MHz | same |
| Thermals (Tsens/case/chg °C) | 37–40 / 35 / chg 41.7, battery 33.2 °C (screen on, charging) | 31–36 / 32 / chg 31.9, battery 30.7 °C (screen off) |
| Battery | 26% (below the 40% floor), charging at 610–710 mA (cap 700 mA), BYD cell, 796 mAh, cycle_count 2, 4.4 V cell | 46%, charging paused, cycle_count 0 |
| Wi-Fi | same 2.4 GHz AP, RSSI −69, 57 Mbps | RSSI −65, 65 Mbps |
| HA latency (LAN IP) | ping 6.6/40/121 ms (min/avg/max); HTTP GET of `/manifest.json` 13 ms, 200 | ping 10.5/50/213 ms; HTTP 21 ms |
| VPN | a VPN app works; it is not on the doze whitelist by default | same |
| Home app | `com.tct.pepitolauncher/.LauncherActivity` (v01.05.06) | same |
| Lock task | `mLockTaskModeState=NONE`, no device owner; only the GMS MDM admin is active | same |
| `pm set-home-activity` | **available** (`cmd package help`) | available |
| Magisk | service.d holds only charge_limit.sh; no modules | same |

### Charge guard findings
- **The scripts differ.** A's copy lacks the PID single-instance guard. B's log showed 6 "started" lines in 2 minutes, from before that guard existed.
- **A was at 26% even though the guard had enabled charging at 40% earlier.** Why it drained while charging was enabled is unknown.
- **Logic trap:** if the battery is ≤40% and above COOL (38 °C), no branch turns charging back on. If the temperature stays above 38 °C after a heat pause, the phone drains until it shuts down. A 24/7 screen in a warm enclosure makes this plausible. (Fixed since in [scripts/charge-limit](../../scripts/charge-limit/): a heat-pause hysteresis and a `FLOOR` below which a warm phone charges anyway.)
- **Battery draw while paused (B, screen off, USB online):** bms `charge_counter` fell 31 µAh every 25 s, a steady **≈4.5 mA**, and OCV ≈ terminal voltage (3823/3822 mV). batterystats over a longer stretch suggests **~15 mA average while plugged and paused**.
- **Screen-on draw while paused: NOT measured.** Evidence that USB carries most of the load: A, screen on, still pushes 610–710 mA *into* the battery from a 1.5 A port.
- **Cycle arithmetic:**
  - If USB carries the load (likely), the battery loses ~15 mA → 318 mAh (one 80→40 swing) every ~21 h, so about **1 shallow cycle per day**. That is acceptable.
  - If instead the screen-on load (~150–300 mA, a rough figure) comes from the battery, a swing takes 1–2 h, so **12–24 cycles per day**, and the 800 mAh cell would wear out in months.
  - How to measure: screen on for 5 min with charging paused, sampling bms `charge_counter`.
- batterystats estimates screen-on runtime on battery at 2h41m on A (≈290 mA average).

### Hard limits for the designer
1. **No OLED, no AOD.** An "always on" screen means the backlight stays on. The minimum useful brightness is around 6–16/255. There is no ambient-display mode to fall back to.
2. **`homeassistant.local` does not resolve on the phones** (no mDNS on 8.1). Use the LAN IP (or a VPN address).
3. **Plain `http://IP:8123` is not a secure context**, which rules out PWA install, standalone launch, service workers and the Screen Wake Lock API. Workarounds: HTTPS through a VPN-issued cert (some VPNs can issue one), or a page served from `http://localhost` on the phone by a root daemon (localhost counts as secure).
4. **Web pages cannot read the proximity or light sensors** in Chrome 101 (the Generic Sensor API needs a secure context and flags). Presence detection needs a native or root bridge.
5. Chrome 101 most likely lacks `:has()`, container queries, `dvh`, View Transitions and CSS nesting; verify on caniuse. Whether the current HA frontend renders correctly in Chrome 101 is unverified.
6. The single power button has no volume keys. On **B**, `camera_double_tap_power_gesture_disabled=0`, so a double press opens the camera. On A it is disabled (2).
7. Core_ctl, a big cluster capped at 1.09 GHz and a 2018 Adreno driver: aim for compositor-only animation (transform/opacity) at 720p. Canvas or blur/backdrop-filter at 60 fps is risky; not benchmarked.
8. Wi-Fi is 2.4 GHz only, with RSSI in the mid −60s. Ping spikes to 120–213 ms against 13–21 ms HTTP look like Wi-Fi power-save (likely, not proven). Keep a persistent WebSocket open, or the first tap after idle will feel slow.

### Root-only tricks available
- Direct backlight writes: `echo N > /sys/class/leds/lcd-backlight/brightness`. This works below the 135 cap and also up to 255, but the framework may overwrite it unless auto-brightness is off.
- Proximity/light presence daemon: the proximity sensor is a wake-up sensor; a root or native helper can wake the screen or dim it to 0.
- `stay_on_while_plugged_in` must include the AC bit (value 3 or 7, **not 2**), because both phones report AC.
- `settings put global policy_control immersive.full=*` (still supported on 8.1) hides the status bar.
- `pm set-home-activity <kiosk/.Main>` replaces the Palm launcher. `locksettings set-disabled true` removes the swipe keyguard.
- `dpm set-device-owner` enables true lock task. It works only on a phone with no accounts signed in, and is blocked while a Google account is signed in. It needs a custom APK with a DeviceAdminReceiver; Chrome cannot fill that role.
- Magisk service.d boot hooks are proven to work (charge guard). Chrome-as-WebView means a tiny custom WebView APK gets the Chrome 101 engine.
- Disable OEM interference: pepitolauncher (holds 3–4 notification listeners), Life Mode (the QS tile on A; `life_mode_settings=0`, off), the GMS setup activity, Fleksy keyboard.

### Could not determine
- Proximity sensor maxRange/resolution (not shown in dumpsys) and whether it can detect a person beyond a few cm. Probably a 0/5 cm binary reading.
- Screen-on current draw while charging is paused, and so the real cycle rate.
- Why A drained to 26%.
- Chrome GPU rasterization status (chrome://gpu not opened) and real frame rate with animation.
- Whether Life Mode cuts Wi-Fi when the screen turns off. It was off; its behaviour was not verified.
- Whether a WebAPK can be minted (needs GMS/Play and a signed-in account).