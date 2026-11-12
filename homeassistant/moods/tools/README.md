# tools

## provision.sh

Turns a Palm phone (PVG100, Android 8.1, rooted with Magisk) into a Moods panel. Run it on any machine with `adb` and `python3`, with the phone connected over USB and USB debugging enabled.

```bash
cp tools/config.example.json tools/config.bedroom.json   # then fill in haUrl and token
chmod 600 tools/config.bedroom.json                       # it holds the token
tools/provision.sh <adb-serial> bedroom
```

- `<adb-serial>` comes from `adb devices`.
- `<panel>` is the room this phone sits in. It is written into the config, and the UI uses it to show that room's moods first.

Options:

| Option | Default |
| --- | --- |
| `--apk FILE` | `shell/app/build/outputs/apk/debug/app-debug.apk` |
| `--config FILE` | `tools/config.<panel>.json` |
| `--charge-guard FILE` | `$CHARGE_GUARD`, else [`scripts/charge-limit/charge_limit.sh`](../../../scripts/charge-limit/) in this toolkit |
| `--skip-charge-guard` | install the guard (this needs root) |

You can build the APK on another machine and pass it with `--apk`. Debug builds are signed with that machine's `~/.android/debug.keystore`, so always build on the same machine, or copy its keystore. If the signature changes, `install -r` fails, and the only way out is to uninstall, which also deletes the stored token.

The config needs:
- `haUrl`: the **LAN IP** (or a VPN address such as a Tailscale one). `.local` names do not resolve on Android 8.1. `http://192.168.1.10:8123`, with or without a path copied from the browser, is turned into `ws://192.168.1.10:8123/api/websocket`; the check prints the URL the app will use.
- `token`: a Home Assistant long-lived access token. Create one under your HA profile, then Security. A dedicated HA user for the panels is a good idea.

Optional, for the UI (the app passes keys it does not know straight to the page):
- `tempEntity`: the entity whose temperature the idle face shows on its status line, rounded, e.g. `Wind Down · 68° · Diffuser on`. Leave it out for no temperature.
  - A `sensor.*` is read from its state. A `climate.*` (a thermostat) is read from its `current_temperature` attribute, because its state is the HVAC mode.
  - The example uses `sensor.bedroom_temperature`, an air-temperature sensor in the bedroom. Use any temperature sensor in the room the phone sits in.
  - Alternatives: a thermostat such as `climate.thermostat` (its `current_temperature` is the room temperature it is working from). Do not use a bed-cooling climate entity: its `current_temperature` is usually the bed surface, not the room.
  - If the entity reads `unavailable`, the face simply shows no temperature.
  - The panel's HA user must be able to read the entity. `check_config.py` passes the key through without checking it; the UI ignores a value that is not an entity id.

**Settings from Home Assistant.** Two of the phone's settings can also be changed on the "Moods" dashboard in Home Assistant (Phones view), without adb:
- the night hours (`input_select.moods_panel_<panel>_night_hours`);
- the day brightness of the screen (`input_select.moods_panel_<panel>_screen`).

The first option of each, "This phone's own hours" and "Usual (100%)", keeps the `nightStart`/`nightEnd` written here and the usual levels. So does anything the phone cannot read. The helpers exist for the panels `bedroom` and `living_room`. A phone with another panel name has none and simply uses its config. To give it some, copy the two `moods_panel_bedroom_*` helpers in `ha/packages/moods/moods_settings.yaml` under the new name, then add a section to the dashboard's Phones view. The panel's Home Assistant user needs to be able to read them, which any non-admin user can.

**Custom moods and placement.** The moods made on the dashboard's My moods tab, and each mood's "Where it shows" and "Order in the deck", reach a phone only with app 0.2.0 or newer (`versionName` in `shell/app/build.gradle.kts`). To update a phone, build the APK and run `provision.sh` again with the same panel name and config (every step is idempotent; `install -r` keeps the app's data, and the config is pushed again last). An older app shows no custom moods and ignores placement, and the new app shows exactly the old deck against a package without them. The panel name matters here too: "Only on the Bedroom Palm" and "Not on the Bedroom Palm" match the panel `bedroom`, and "Living room" matches `living_room`.

`tools/config.*.json` and `tools/state/` are git-ignored. The script warns if the config file can be read by other users.

The config is checked by `tools/check_config.py`, which applies the app's own rules (`ShellConfig.parse`): strings for `haUrl`, `token`, `panel`, `deviceName`, `nightStart` and `nightEnd` (null or blank means absent), `true`/`false` for `mock`, a URL whose host and port the app can parse, and no duplicate keys. `python3 tools/test_check_config.py` runs the cases in `tools/config-cases.json`, which the shell's unit tests also run against the app's parser.

### Behaviour

- **Checks before changing anything:**
  - the device is connected;
  - the APK, config and charge guard exist;
  - the config is valid;
  - root is available.
  If any check fails, the phone is left untouched.
- **Never prints the token.**
  - The finished config is written to a private temp file, pushed, then deleted.
  - The config is pushed last, right before Moods is started, so it spends seconds at most on shared storage.
  - On the phone, the app imports it into private storage and deletes the pushed file. If the app rejects it, the app deletes it too, and the script removes anything left over.
- **Safe to re-run.** On the first run it saves the phone's original values in `tools/state/<serial>.env`. Later runs keep that file, so undo always goes back to the phone as it was before Moods.
- **Ends by** starting Moods and reading the app's log from this run: `Imported config` or `Config unchanged` means success. `Rejected config.json: <reason>` prints the reason and exits non-zero, as does no answer within 15 s (2 min if the app says it is waiting out a crash back-off). The phone then keeps its previous config.

### What it changes, and how to undo each change

Run each undo command with `adb -s <serial> shell ...`. The "before" values are in `tools/state/<serial>.env`.

| # | Change | Command used | Undo |
| --- | --- | --- | --- |
| 1 | Installs Moods (`com.palmmoods.shell`) | `adb install -r app-debug.apk` | `adb uninstall com.palmmoods.shell`. This also deletes the stored config and token. |
| 2 | Makes Moods the home app. It then also starts at boot. | `cmd package set-home-activity com.palmmoods.shell/.KioskActivity` | `cmd package set-home-activity <HOME_ACTIVITY>`. If `HOME_ACTIVITY` is `unknown` or contains `ResolverActivity` (no single home app was set before; the state file then says so), use the Palm launcher instead: `com.tct.pepitolauncher/.LauncherActivity`. |
| 3 | Turns off the swipe keyguard | `locksettings set-disabled true` | `locksettings set-disabled <KEYGUARD_DISABLED>`. If that value is `unknown`, use `false`. |
| 4 | Turns off "double-press power for camera" | `settings put secure camera_double_tap_power_gesture_disabled 1` | `settings put secure camera_double_tap_power_gesture_disabled <CAMERA_GESTURE_DISABLED>`. If that value was `null`, use `settings delete secure camera_double_tap_power_gesture_disabled`. |
| 5 | Removes any display density override, so CSS sizes are the same on both phones | `wm density reset` | `wm density <DENSITY_OVERRIDE>` (phone A had 272). Do nothing if it was `none`. |
| 6 | Installs the current charge guard as a Magisk boot script and restarts it. Every running copy is stopped first. Unless the state file says the phone had none before Moods (`CHARGE_GUARD_INSTALLED=no`), a copy found there is kept once as `/data/adb/charge_limit.sh.before-moods`. If the first run could not tell (`unknown`, no root yet), a later run with root looks again and records the answer. | push to `/data/local/tmp`, then as root: copy to `/data/adb/service.d/charge_limit.sh`, `chmod 755`, kill running copies, `nohup sh ... &` | **To restore the old copy:** `su -c 'cp /data/adb/charge_limit.sh.before-moods /data/adb/service.d/charge_limit.sh'`, then `reboot`. **If there was none before:** `su -c 'rm /data/adb/service.d/charge_limit.sh; echo 1 > /sys/class/power_supply/battery/battery_charging_enabled'`, then `reboot`. |
| 7 | Pushes `config.json`, stops Moods and starts it. The app imports the file into its private prefs and deletes it. | `adb push <tmp> /sdcard/Android/data/com.palmmoods.shell/files/config.json`, `am force-stop`, `am start -W` | `pm clear com.palmmoods.shell` forgets the config and puts the app back in demo mode. The script removes the pushed file in every case; to be sure: `rm -f /sdcard/Android/data/com.palmmoods.shell/files/config.json*` |

Temporary files on the phone (`/data/local/tmp/charge_limit.sh`, `/data/local/tmp/moods-guard.sh`) are deleted by the script.

### Deliberately not changed

These came up in `docs/device-profile.md`. The contract does not ask for them, so the script leaves them alone:

- `stay_on_while_plugged_in`: not needed, because the app holds `FLAG_KEEP_SCREEN_ON` while it is in front.
- `policy_control` immersive mode: the app hides the system bars itself.
- Disabling the Palm launcher, Life Mode, the Fleksy keyboard or the GMS setup activity. On a phone signed in to a Google account, the GMS setup activity could still pop up over the panel.
- Device owner / lock task.
- `screen_off_timeout`.

### Charge guard

The guard is the toolkit's [charge limiter](../../../scripts/charge-limit/). An older copy had a trap: with the battery at or below 40% and warmer than 38 °C, no branch turned charging back on, so a phone that stayed warm could drain until it shut down. The current version fixes this (heat-pause hysteresis and a `FLOOR`), and `provision.sh` installs whichever copy you point it at, so use the current one.
