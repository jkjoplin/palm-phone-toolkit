# Palm Moods: architecture contract

Rooted 2018 Palm phones (PVG100, Android 8.1 / SDK 27, Chrome 101 WebView, 3.3" 720x1280 LCD) sit always-on as mood controllers for a Home Assistant house. You swipe through preset moods and press-hold to set one. The chosen look is **Ember** (warm analog glow, Fraunces serif).

This file is the contract between the three parts. If a part needs to deviate, it changes this file in the same change.

```
+---------------------- Palm phone ----------------------+        +------- Home Assistant -------+
| shell/  Kotlin app "Moods" (HOME activity)             |        | packages/moods/              |
|   - fullscreen WebView, keep-screen-on, boot = home    |        |   moods_core.yaml   helpers  |
|   - window brightness, haptics, light + proximity      |        |   moods_roles.yaml  roles    |
|   - Wi-Fi lock, crash recovery, escape hatch           |        |   <slug>.yaml  one per mood  |
|   - JS bridge:  window.Shell  <->  window.__shell()    |        |                              |
| ui/     Ember web UI (bundled as app assets)           | <====> | WebSocket API                |
|   - owns the HA WebSocket (auth with long-lived token) |   ws   | script.mood_* + attributes   |
|   - deck, hold-to-set, confirmation marks, undo, night |        | input_text.house_mood        |
+--------------------------------------------------------+        +------------------------------+
```

Principles
- **Moods are Home Assistant data.** A mood is one YAML file. Voice, automations, scripts and every phone all set the same mood and see the same current mood.
- **Moods name roles, not devices.** Devices, accounts and integrations come and go. Only `moods_roles.yaml` knows real device entity ids. A mood must still run when a role is empty or a device is missing.
- **The shell owns hardware; the UI owns everything visible and the HA connection.** The UI must also run in a desktop browser with no shell (mock or direct connection) so it can be developed and reviewed off-device.
- **Swiping never changes the house.** Only a completed 600 ms hold does.
- Hard device limits: animate only transform/opacity, no backdrop-filter/canvas/blur animation, no Chrome >101 features (`:has`, container queries, nesting, `color-mix`, `dvh`, view transitions, `text-wrap: balance`). Dark-first: it sits beside a bed.

## 1. Shell (shell/, Kotlin, minSdk 27)

- Application id `com.palmmoods.shell`, label "Moods". One activity, `KioskActivity`, with intent filters MAIN+LAUNCHER and MAIN+HOME+DEFAULT so it can be the home app (which also makes it start at boot).
- Fullscreen immersive-sticky, `FLAG_KEEP_SCREEN_ON`, shows over and dismisses the keyguard, portrait locked.
- Loads `file:///android_asset/ui/index.html` in a WebView (JS + DOM storage on, media gesture not required, text zoom 100, overscroll off, long-press/selection disabled, hardware accelerated). No network content is loaded as a page; the page opens a `ws://` socket to Home Assistant itself. `usesCleartextTraffic=true`.
- The `ui/` folder of this repo is copied into the APK assets at build time (the `copyUiAssets` Gradle task), except `ui/dev/` (test tools and screenshots), which never ships. No other build step for the UI.
- Holds a `WifiManager.WifiLock(WIFI_MODE_FULL_HIGH_PERF)` while resumed.
- Does not turn the screen on by itself (no `setTurnScreenOn`): a restart at night leaves a screen that was turned off dark.
- Recovery:
  - `onRenderProcessGone` rebuilds the WebView, waiting 10 s after 3 deaths in a minute. A WebView that cannot be built (WebView package missing or mid-update) leaves a black screen and is retried after 10 s, 30 s, then every 60 s.
  - Watchdog, only while resumed: if the page has not called `Shell.heartbeat()` for 30 s the shell reloads it; every third silent period rebuilds the WebView instead; after three silent periods in a row the period doubles up to 5 min. A heartbeat or a resume resets it.
  - Uncaught exceptions restart the activity after 1.5 s, then 15 s, then 2 min in a crash loop (counted over a minute). A new activity also waits out that back-off on a black screen before starting anything, because the system may relaunch a home app sooner.
- Escape hatch: `Shell.openSettings()` opens Android Settings (the UI triggers it from a hidden gesture). Home returns to Moods; if nobody presses it, Moods returns by itself after 5 min. Immersive-sticky still lets anyone swipe in the system bars, and adb always works.
- Config: on start, on every resume and on a new intent, if `<external files dir>/config.json` exists (`/sdcard/Android/data/com.palmmoods.shell/files/config.json`), import it into private SharedPreferences and delete the file; reload the page if the config changed. A file with any malformed value is rejected as a whole and the previous config is kept. A rejected or unsavable file is deleted too: the token never stays on shared storage. With no config the shell reports `mock: true`. The shell logs exactly one of `Imported config: ...`, `Config unchanged: ...` or `Rejected config.json: <reason>` (never the token), and `Recent crash: starting up in <ms> ms` while it waits out a crash back-off; `tools/provision.sh` decides success from these, so they are part of this contract.
- Debug builds also carry a bridge test page at `file:///android_asset/ui/_bridge/index.html` (from `shell/app/src/debug/assets/`, not from `ui/`), shown with `am start ... --es page bridge`. The UI must not use a `ui/_bridge/` folder.

### Bridge: page -> shell (`window.Shell`, added with `addJavascriptInterface`; all calls synchronous)

| Call | Meaning |
| --- | --- |
| `getConfig(): string` | JSON: `{ "mock": bool, "haUrl": "ws://192.168.1.10:8123/api/websocket", "token": "...", "panel": "bedroom", "deviceName": "palm-bedroom", "nightStart": "22:00", "nightEnd": "07:00", "appVersion": "0.1.0" }` |
| `setBrightness(level: number)` | `0..1` sets this window's brightness (shell clamps to its minimum, about 1/255); `-1` returns to system brightness |
| `haptic(kind: string)` | `"tick"` (about 12 ms), `"thump"` (about 30 ms), `"error"` (two short) |
| `heartbeat()` | called by the page every 5 s |
| `openSettings()` | escape hatch |
| `reload()` | reload the page |
| `log(level: string, msg: string)` | to logcat, tag `Moods` |

`getConfig()` details:
- `haUrl` and `token` are `""` when unset, never null. `mock` is true when either is unset, or when the file says `"mock": true`.
- `haUrl` is normalized to the WebSocket URL: `http(s)://host:port` with any path becomes `ws(s)://host:port/api/websocket`; a path already ending in `/api/websocket` is kept; a `ws(s)://` URL with another path is rejected.
- Defaults: `panel` `"default"`, `deviceName` `"palm-<panel>"`, night `22:00`-`07:00` (times are normalized to `HH:MM`).
- `appVersion` is the app's own `versionName`; a file that carries one is ignored for that key.
- Keys the shell does not know are passed through to the page unchanged (JSON `null` values are dropped), so the UI can grow settings without a shell release. The one the UI reads today is `tempEntity` (section 3).

### Bridge: shell -> page

The shell calls `window.__shell(type, payload)` (payload is an object) via `evaluateJavascript`. The page defines `window.__shell` before `DOMContentLoaded`; the shell must tolerate it being absent.

| type | payload |
| --- | --- |
| `"sensor"` | `{ "lux": number or null, "near": bool or null }` on change, lux at most once per second |
| `"power"` | `{ "level": int, "tempC": number, "charging": bool, "plugged": bool }` on change and every 60 s |
| `"net"` | `{ "wifi": bool, "rssi": int or null }` on change |
| `"lifecycle"` | `{ "state": "resume" or "pause" }` |

- After every page load the shell re-sends the latest `sensor`, `power`, `net` and `lifecycle` events, and `power` repeats every 60 s. The UI must treat repeated identical events as harmless. Expect a pause/resume pair whenever the shell is started with an intent (Home, a restart alarm, provisioning).
- `sensor`, `power` and `net` events stop while paused.
- `power.charging` is true only while the battery reports CHARGING (a full or guard-paused battery reads false); `plugged` is any plug type.
- `net`: Wi-Fi up/down is sent at once; RSSI-only changes at most once per 10 s.

## 2. Home Assistant (ha/packages/moods/, deployed into Home Assistant's `packages/`)

File basenames are package names: they must be slugs (so not `_core.yaml`) and unique across the whole `packages/` tree, sub-folders included.

- `moods_core.yaml`
  - `input_text.house_mood` (current mood slug; reads `unknown` until the first mood is ever set) and `input_text.house_mood_previous`.
  - `input_text.house_mood_notice` (max 255): `""` while the last mood request was accepted. When one is refused it is set to `<slug>|<ISO 8601 time with microseconds>|<reason>`, e.g. `focus|2026-01-01T12:00:00.000000+00:00|Vacation mode is on, so only Away can run.` The time makes every refusal a new state (so `state_changed` fires even for a repeat). It is cleared to `""` by the next accepted mood. `unknown` means no notice. `mood_begin` also fires an event `mood_refused` with `{slug, reason}` (optional extra; the UI need only watch the helper).
  - `input_datetime.house_mood_since`: when the current mood was last set.
  - `script.mood_begin` with field `slug`, called directly by each mood with `response_variable`; it answers `{proceed: bool, reason: string}`:
    - If another mood started *after* the caller is still running (two moods chosen within milliseconds), the caller gets `proceed: false` and nothing is written: the newest choice wins. This is not a refusal; no notice.
    - When `input_boolean.vacation_mode` (an optional helper the house may already have) is on and the slug is not `away`: `proceed: false`, notice set as above. This check always comes first.
    - When the caller's script (`script.mood_<slug>`, found by entity id, never by `mood_slug`) has a `mood_window` and Home Assistant's local time is outside it: `proceed: false`, notice and `mood_refused` event as above, with the reason `<mood_name> only runs between <from> and <to>.` (e.g. `Good Morning only runs between 05:00 and 11:00.`). `from` is inclusive, `to` exclusive, and a `from` later than `to` crosses midnight. A malformed window (not a map, a missing or non-`HH:MM` time, `from` equal to `to`) never blocks the mood: it runs as if it had no window, and `system_log.write` logs a warning (logger `palm_moods.mood_begin`) on every run. `ui/dev/lint.js` rejects a malformed or unapproved window in the package. A refusal writes nothing but the notice and runs none of the mood's role actions. One thing it cannot undo: a mood script is `mode: restart`, so a tap on a mood that is still running stops that earlier run before `mood_begin` decides. If the new run is then refused, the earlier run stays stopped where it was (Good Morning's lamps stay at the step the rise had reached) and `house_mood` still names that mood, which was accepted when it started. This happens when Good Morning is started in the last 90 s before 11:00 and tapped again after 11:00, or when vacation mode is turned on during a mood's run.
    - Otherwise: stops any other running mood, clears the notice, and if the current mood is `away` and the new one is not, starts `script.role_thermostat_resume` (leaving Away restores the thermostat). Moves current to previous (unless re-running the current mood) and sets current and `house_mood_since`. `proceed: true`.
  - `script.mood_undo`: re-runs the previous mood if there is one. That run goes through `mood_begin`, so Undo into a mood that vacation mode or its time window refuses is refused the same way.
  - `binary_sensor.mood_outdoor_hold`: on while the current mood has `mood_holds_outdoor: true` and either was set less than 4 h ago, or was set from 15:00 on and it is not yet 01:00 the next morning. "The current mood" is always `script.mood_<house_mood>`, found by entity id; no template in the package reads `mood_slug`.
  - Any exception handling for existing automations that fight moods (for example one that turns the outdoor lights off at 22:30) is expressed as a condition those automations can check, documented in `ha/README.md`; existing automations are not edited by this package. The package may add its own small automations (today one: `automation.moods_outdoor_lights_off_late`, which turns the outdoor roles off when a hold ends after 22:30, or at 01:00 after a mood with `mood_lights_outdoor: true`).
- `moods_roles.yaml`: the only file with real device entity ids. Roles are ordinary HA entities so moods can target them, each tolerant of missing members: light groups (`light.role_<name>`), switch groups (`switch.role_<name>`), speaker groups (`media_player.role_<name>`), thin wrapper scripts where a role is not a light or switch (`script.role_<name>_<verb>`), and read-only mirrors (`binary_sensor.role_<name>`) so a wrapper's effect can be watched.
  - Guest room: the night light is opt-in. `input_boolean.moods_guest_room_night_light` starts off and stays off until a supervised test passes; while it is off, no mood lights the guest room. `input_boolean.moods_leave_guest_room_alone` (starts off) stops moods touching the guest room lamp at all.
  - A wrapper script sets its device ids and safety limits in a first `variables:` step inside its `sequence`, never in script-level `variables:` (those are only defaults: a caller's data overrides them).
- `moods_music.yaml`: `script.role_music_play` (fields `mood`, `speakers`, optional `music_id`, `music_type`, `music_volume`) and `script.role_music_stop`. A mood's music is given either in its own `role_music_play` step (`music_id`, which wins) or in the `library:` here.
- `moods_settings.yaml`: the settings on the Home Assistant "Moods" dashboard, plus `script.moods_settings_usual` (every `input_select.moods_*` back to its first option) and the dashboard's registration (`lovelace: dashboards: palm-moods`, YAML mode, `require_admin: false`). Every setting is an `input_select` with no `initial:` whose first option is today's behaviour ("Usual (...)"), so a new, restored-out-of-list or never-chosen helper is today's behaviour with no seeding.
  - Mood settings: `input_select.moods_<slug>_<name>` (today `_look`, and `_bed` for Lights Out). The numbers in the option text are the values. A mood reads only its own, with the id built from its entity id, in a `variables:` step right after the `begin.proceed` condition. It takes the numbers (`regex_findall('-?[0-9]+(?:[.][0-9]+)?')`, so a sign or decimal stays with its number) and checks them all at once in one `ok`: every one plain digits, exactly the expected count, each inside the mood's range. Each value is `look[i] if ok else <today's literal>`, so a setting gives either all of its values or all of today's, never a mix. The reader template must never raise. Ranges keep every approved card text and mark true. `ui/dev/lint.js` checks that the first option carries exactly the mood's fallbacks and that every option is in range.
  - Panel settings, read by the UI (section 3): `input_select.moods_panel_<panel>_night_hours` (first option the phone's own hours; then `"HH:MM to HH:MM"`, or `No night hours`) and `input_select.moods_panel_<panel>_screen` (`"<words> (<n>%)"`, n 50 to 150, first `Usual (100%)`), one pair per panel name.
  - The dashboard file is `ha/dashboards/palm_moods.yaml`, deployed to `/config/dashboards/palm_moods.yaml` (never under `packages/`, where any `.yaml` is loaded as a package). Built-in cards only; every button that changes the house asks first. Registering it needs one restart; edits to the file need only a browser refresh.
- `<slug>.yaml`, one per mood:
  - `script.mood_<slug>` (`mode: restart`). Its sequence is: `script.mood_begin` (with `slug` taken from the script's own entity id, and `response_variable: begin`), then a `condition` that `begin.proceed` is true, then (optionally) one `variables:` step reading the mood's own setting as above, then a `parallel:` block of role actions with `continue_on_error: true`.
  - A `homeassistant: customize:` entry for `script.mood_<slug>` carrying the UI metadata as attributes:

```yaml
homeassistant:
  customize:
    script.mood_wind_down:
      mood: true
      mood_slug: wind_down           # informational: equals the script name after mood_. Nothing reads it to find a mood (mood_begin, Undo, the outdoor hold and the UI all use the entity id); the UI logs a mismatch
      mood_name: Wind Down
      mood_tagline: Lamps low and warm. Diffuser on. Settle in.
      mood_order: 10
      mood_scope: Bedroom            # shown on the card
      mood_panels: [bedroom]         # panels that show it first; every mood stays reachable everywhere
      mood_glyph: candle             # key into the UI's glyph set; unknown keys fall back to a neutral glyph
      mood_palette:                  # all parts optional; see below
        base: "#130905"
        glows: ["#d6742c", "#80341e", "#604670"]    # [low lamp, band, counter-light]
        accent: "#f2a65e"
        ink: "#f8e8d4"               # optional: the clock and name colour
        sky:                         # optional: a hand-tuned sky, used instead of the generated one
          - [band, "#80341e", 0.38, 640, 300, 50, 30, 2]
          - [lamp, "#d6742c", 0.54, 640, 520, 50, 96, 1]
          - [glow, "#604670", 0.14, 380, 380, 94, 2, 3]
      mood_status: Diffuser on       # optional fragment for the idle status line
      mood_night: false              # true = a night mood (Lights Out): a small faint lamp in its generated sky, and the idle face goes to night while it is current and the room is not lit (section 3)
      mood_holds_outdoor: false      # HA only: true = keep porch/driveway on past 22:30 (Hosting)
      mood_lights_outdoor: false     # HA only: true = turns outdoor roles on; they go off at 01:00
      # mood_window: { from: "05:00", to: "11:00" }   # optional, HA only: mood_begin refuses the mood outside these local hours (Good Morning has this one); quote both times
      mood_touches:                  # confirmation marks; each is one role entity to watch
        - { label: Lights, entity: light.role_bedroom_lamps, expect: "on" }
        - { label: Scent,  entity: switch.role_diffuser, expect: "on" }
```

- A touch's `entity` is always a role: `light.role_*`, `switch.role_*`, `binary_sensor.role_*` or `media_player.role_*`. Glyph keys in use: `candle`, `curtain`, `bulbs`, `moon`, `sunrise`, `desk_lamp`, `glasses`, `key`, and `ember` (the neutral fallback, used by the Showcase example).
- The UI discovers moods from a `subscribe_entities` subscription filtered to the `script` domain (section 3): every `script.*` whose attributes include `mood: true`, this panel's moods (`mood_panels`) first, then by `mood_order`. A mood's slug is its entity id after `script.mood_`, the same value `mood_begin` writes to `house_mood`; a `mood_slug` that disagrees (a copied file) is ignored and logged as a warning. Current mood = `input_text.house_mood`. To set a mood it calls service `script.turn_on` on the mood's entity. Undo calls `script.turn_on` on `script.mood_undo`.
- `mood_palette.glows` are, in order, the card's low lamp (behind the lower centre), its broad band (high on the wall) and a faint counter-light (in a corner). Without a `sky`, the UI generates the sky from them: each layer's strength comes from the colour's luminance, so any palette stays dim enough for a bedroom; a `mood_night` mood gets a small faint lamp; a grey counter-light about as dark as the room is left out; the counter-light's corner follows the card's place in the deck, so neighbours differ. A missing or malformed part is derived from the rest (or from the house default).
- `mood_palette.sky` (optional) is a hand-tuned sky, up to 4 layers, each `[kind, "#rrggbb", alpha, width, height, x%, y%, drift]` (or a map with keys `kind color alpha w h x y drift`). `kind` is `band`, `lamp` or `glow`; width and height are in 1/360 of the screen's short side; drift is 1 to 3. The UI clamps every value (alpha at most 0.62, and no layer may add more than luminance 100 at its centre) and drops bad layers; with none left it generates the sky. The five Ember moods carry the approved mockup skies this way, and Focus a hand-tuned bright, cool one; `ui/dev/lint.js` fails if any package sky would be clamped or dropped, or if a mockup sky, ink or accent changes.
- `mood_palette.ink` (optional): the clock, name and status colour. Without it the UI derives a warm cream from the accent. A given `accent` is lightened only below luminance 100; a derived one below 135. A given `ink` is kept between luminance 150 and 248 (a derived one 170 to 235), and a `base` brighter than luminance 26 is darkened.
- HA validates a package's `customize` only when the core config loads; `check_config` does not catch a bad block, which is then dropped with a log warning. The UI must tolerate a `script.mood_*` that lacks some or all `mood_*` attributes (without `mood: true` it is simply not a mood); without `mood_name` the card takes the script's alias minus `Mood: `, or the slug in title case. The deck shows at most 40 moods and 5 touches per mood.
- A confirmation mark fills when the touched entity reports the expected state (already, or by a later state change) within 8 s; otherwise it stays hollow with "<label> didn't answer".
- Refusals: after a completed hold, if `input_text.house_mood_notice` changes to a non-empty value whose slug is the mood just set, the UI shows the reason instead of hollow "didn't answer" marks.
- Card text (`mood_tagline`, `mood_status`) promises only what the mood does today: no music while none is configured (the moods ship without music; the `role_music_play` steps stay and do nothing), and nothing about the guest room while its night light is opt-in and off. `ui/dev/lint.js` holds the approved text for every mood.
- Adding a mood = add one file (its music, if any, can be given in the file itself; a time window, if any, is its `mood_window`), then reload core config and scripts. No app or UI change, unless it wants a new glyph. A setting on the dashboard for it is optional: an `input_select.moods_<slug>_look` in `moods_settings.yaml`, its reader step, and a dashboard section.

## 3. UI (ui/, plain HTML/CSS/JS, no build step, no CDN)

- Entry `ui/index.html`; fonts are bundled files under `ui/fonts/` (no network). Layout is sized from a `--u` unit that the page sets from `window.innerWidth`/`innerHeight` (1u = 1px at 360x640), never from viewport-height units (`vh`, `dvh`), which ignore the system bars on Android; only the sky's drift keyframes use `vw`. Correct at 360x640 and 424x753.
- The page is loaded from `file:///android_asset/` with file access from file URLs off. Use classic `<script src>` and relative `@font-face` only: no ES modules, no `fetch`/XHR of local files. No iframes or remote content (`window.Shell`, and so the token, is visible to every frame).
- The page starts its `Shell.heartbeat()` interval first thing in its script, before the HA connection or any other start-up work that can fail, and keeps it running whatever the connection state. Otherwise the shell's watchdog keeps reloading it. The one exception: if the app's own scripts have not finished booting 30 s after load (a script error), the heartbeat stops, so the watchdog reloads a page that would otherwise stay dead.
- Never `console.log` or `Shell.log` the config object or the token: console output goes to logcat under the tag `Moods`, which `provision.sh` prints.
- Runs in three modes, chosen at start:
  1. **Shell + config**: `window.Shell` exists and `getConfig().mock` is false: connect to HA with the token.
  2. **Mock**: no shell config (or `?mock=1`): the five demo moods, simulated confirmations. Shows a small "Demo" tag.
  3. **Browser direct** (development): `?ha=ws://host:8123/api/websocket&token=...` connects from a desktop browser.
- Minimal HA WebSocket client in the page (`ui/ha.js`). It never takes the raw `state_changed` firehose (a house can have a thousand entities):
  - auth with the token; after `auth_invalid` it retries only every 5 min (HA bans IPs that keep failing) and the face says the token was turned down.
  - `subscribe_entities` with `include: { domains: [script], entities: [input_text.house_mood, input_text.house_mood_previous, input_text.house_mood_notice, <tempEntity>, input_select.moods_panel_<panel>_night_hours, input_select.moods_panel_<panel>_screen] }` for the moods, the current mood and this panel's settings (`<panel>` is the config's panel, lowercased, runs of anything but `[a-z0-9_]` turned into one `_`, at most 32 characters; no settings ids when that is not a valid entity id). Its first event is the full filtered state (so no `get_states`); later events are partial diffs, merged into the last state, never replacing it. Moods added by a script reload arrive on it by themselves.
  - a second `subscribe_entities` with `entity_ids` = every mood's touch entities, replaced (`unsubscribe_events`) when that set changes. HA ANDs `entity_ids` with `include`, so the two are never combined in one subscription.
  - `call_service`; a call with no result within 5 s means the link is half-open: the UI reconnects at once, also when the card has already gone back to the face, and says "Home Assistant didn't answer." while the card is still showing. Ping every 30 s, and a pong missing for 10 s drops the socket. Reconnect with backoff (1 s to 30 s), and at once (backoff reset) only when the shell reports Wi-Fi back (`net.wifi` false to true) or a resume. Any other `net` event (Wi-Fi gone, an RSSI-only update, the replay after a page load) at most pings a socket that has been quiet for 5 s; it never resets the backoff.
  - A full dump after a reconnect is merged like a script reload: if it has fewer moods than the deck, the shrink must hold for 2 s before the deck drops them, and the cached list is not overwritten meanwhile. Only the very first dump is taken as it is.
  - Works for a non-admin HA user: in 2026.11 `subscribe_entities` has no `require_admin` and filters states by the user's read permission (`subscribe_trigger` is admin-only and is not used).
  - While disconnected, or while the shell reports no Wi-Fi, the deck is still browsable but hold-to-set is disabled with a quiet "Reconnecting" note (on the face after 5 s).
- `input_text.house_mood` is the truth. Home Assistant accepts a `script.turn_on` it then does nothing with (a missing entity is only logged; a mood whose begin steps are missing; `mood_undo` with no previous mood; a refused previous mood). So:
  - after a hold, if `house_mood` has not reached the mood within 8.5 s (8 s when its marks time out) and no refusal arrived, the face and deck go back to `house_mood` with "Home Assistant didn't set <name>."; this only once the call was answered: a call with no answer, or whose link was lost with it, leaves the store with nothing heard from HA since, so the face keeps the mood and the reconnect's full state decides (it shows whatever the house has);
  - after Undo, a refusal notice for the mood Undo went back to shows its reason on the face; if `house_mood` has not reached it within 8 s, the face goes back with "Undo didn't go through."; both with the error haptic;
  - a card whose script has gone from Home Assistant (a reload while the deck was open) refuses the hold.
- Optional config key `tempEntity` (the shell passes unknown keys through; `?temp=` in a browser): the entity whose temperature is shown, rounded, on the idle status line. A `sensor.*` is read from its state; a `climate.*` from its `current_temperature` attribute (its state is the HVAC mode). It is added to the first subscription's `include.entities`. A value that is not an entity id, or a state that is not a number, shows no temperature; so does no key. The bedroom default is in `tools/config.example.json`.
- Behaviour is the Ember mockup's: idle face (clock, status line), deck (scroll-snap, crossfading skies), 600 ms hold, bloom, confirmation marks, Undo for 10 s, return to idle after 4 s / 20 s.
- Brightness and night: the UI decides and calls `Shell.setBrightness`, easing each change in four steps over about 0.4 s. Idle is dim, interaction is brighter, night is the darkest red-shifted motionless face. Night is the config hours, or a dark room (lux under about 3 for 30 s), or, on the idle face only, a current mood with `mood_night` while the room is not lit. A deck opened from a night face stays night (at the woken level) until it closes or the room is lit, so opening the deck from the Lights Out face in a dim room no longer jumps to the day deck's brightness. Lit means lux above about 6 for 10 s (at once for the first reading) and ends as soon as lux is about 6 or less; with no light sensor the room counts as not lit. So after a night on Lights Out the face is the day face once the room is lit. A `near` proximity event or a touch wakes it from night to the dim interactive level; returning from the deck into a night face starts at that level.
- Panel settings (section 2, `moods_settings.yaml`), read from the first subscription and cached with it, applied as soon as they arrive or change. Each is used only when the UI can read it; otherwise the phone behaves as it did before the settings existed:
  - Night hours: an option `HH:MM to HH:MM` (both valid times) replaces the config's `nightStart`/`nightEnd`; `No night hours` means no night by the hours (as equal times do). Anything else (the first option, a missing, unknown or unavailable helper, any other text) means the config's hours.
  - Screen by day: an option with exactly one number n (plain digits; a signed or decimal number makes it unreadable), 50 to 150, multiplies the day levels (`idle`, `rest`, `active`, before the bright-room factor, capped at `max`) by n/100. Night levels are never changed. Anything else means 1.
- Hidden escape gesture: five taps on the clock within 3 s, each less than 0.4 s after the one before, calls `Shell.openSettings()` and returns to the face. A tap on the clock opens the deck at once; the taps that follow quickly enough on the clock's band of the screen count even though the deck is now showing, and do nothing else there. At night the first tap only wakes the face, and counts as the first of the five.
- Keeps the mockup's test parameters (`state`, `mood`, `night`, `static`, `demo`, `fps`). `state=applied` and `demo=1` change the house only in mock mode; against a real Home Assistant they just open the deck. Added for development: `time=HH:MM` (pins the clock and the night hours), `panel`, `temp`, and in mock mode `mockset=many` (20 moods, some deliberately malformed), `never=<entity>`, `outside=<seconds>`, `speed`. In mock mode `time=` also pins the demo house's clock, which its mood time windows follow. `ui/dev/` holds the fake Home Assistant and the test tools (`ui/dev/README.md`); it is never loaded by the page and is left out of the APK.

## 4. Provisioning (tools/)

`tools/provision.sh <adb-serial> <panel>` (run on the machine with adb): install the APK, make the app the home activity, disable the keyguard and the double-press camera gesture, reset any density override, install the current charge guard, and last push `config.json` and start the app, so the token spends as little time as possible on shared storage. Every change it makes is listed in `tools/README.md` with the command that undoes it.

- Needs `adb` and `python3` on the laptop. Reads `tools/config.<panel>.json` (git-ignored, should be `chmod 600`) and accepts `--apk`, `--config`, `--charge-guard` and `--skip-charge-guard`. The phone's original values are kept in `tools/state/<serial>.env`.
- Checks the config with `tools/check_config.py`, which mirrors the shell's parser; `tools/config-cases.json` holds cases both are tested against.
- Success is read from the shell's log lines (section 1, Config): a rejection or no answer within 15 s exits non-zero, and any pushed file left on the phone is removed.

