# ui/dev: testing the Moods UI off the phone

Nothing in this folder is loaded by the page, and none of it ships: the shell's `copyUiAssets` copies `ui/` into the APK without `ui/dev/`. It is only used on a computer. Everything here runs on Node 24 with no npm packages.

The contract is `docs/ARCHITECTURE.md`, section 3.

## The UI in one screen

| File | What it holds |
| --- | --- |
| `../index.html` | Markup, plus the first inline script: the `Shell.heartbeat()` interval, the `window.__shell` queue and `--u` |
| `../ember.css` | The whole look, with the bundled Fraunces `@font-face` rules |
| `../app.js` | Views, deck, hold, confirmation marks, Undo, night, brightness, shell events. **`BRIGHTNESS`, `TIMING`, `LUX` and `HEALTH` at the top are the tuning tables** |
| `../ha.js` | The Home Assistant WebSocket client and the entity store |
| `../moods.js` | Attributes to moods, palette checks, and the sky generator |
| `../glyphs.js` | The glyph set, keyed by `mood_glyph`, with the neutral `ember` fallback |
| `../sim.js` | A simulated Home Assistant, shared by mock mode and `fake-ha.js` |
| `../mock.js` | Mock mode: the five demo moods as HA attributes, and an in-page socket over `sim.js` |
| `../fonts/` | Fraunces variable (roman and italic, latin and latin-ext woff2, axes opsz/wght/SOFT) and `OFL.txt` |

Modes: shell with a config; mock (no config, or `?mock=1`; shows a small "Demo" tag); browser direct (`?ha=ws://host:8123/api/websocket&token=...`).

Test parameters: `state=idle|deck|applied`, `mood=<index or slug>`, `night=1`, `static=1`, `demo=1`, `fps=1`, plus `time=HH:MM` (pins the clock and the night hours, for screenshots), `panel=`, `temp=<entity>` (a sensor, or a climate entity whose `current_temperature` is shown), and in mock mode `mockset=many` (twenty moods, several deliberately malformed), `never=<entity>` (the entity that never answers; default `light.role_patio_lights`), `outside=<seconds>` (another "phone" changes the mood on a timer) and `speed=` (multiplies the simulated delays). `state=applied` and `demo=1` change the house only in mock mode.

`window.__moods.info()` in the page returns the current state (view, connection, current mood, marks, brightness, notes). `window.__moods.trail` lists recent haptics, brightness levels, service calls and status changes. Neither holds the token or the config.

## The fake Home Assistant

```bash
node ui/dev/fake-ha.js                       # ws://127.0.0.1:8767/api/websocket, token "test-token"
node ui/dev/fake-ha.js --port 8768 --token t --never '' --outside 45 --initial focus --clock 07:30
```

It parses the real mood files in `ha/packages/moods/` (with `mood-yaml.js`, a small reader for those files) and runs them on `sim.js`:

- **Protocol:** `auth` (a wrong token gets `auth_invalid` and the socket is closed), `supported_features`, `get_states`, `subscribe_entities` (`entity_ids` and/or `include`/`exclude`, the same filter rules as HA), `subscribe_events` (`state_changed`), `unsubscribe_events`, `call_service`, `ping`.
- **The same messages HA sends:** `subscribe_entities` change events are partial diffs, as in HA 2026.11. A script that runs sends only `s`, `lc`, `c` and the changed attributes (`last_triggered`, `current`). A client that replaces attributes instead of merging them loses `mood: true` here, just as it would on the real box.
- **Moods behave like the package:**
  - `mood_begin` refuses everything but Away in vacation mode, writing the notice.
  - Then it refuses a mood outside its `mood_window` (Good Morning, 05:00 to 11:00) with the package's reason, "Good Morning only runs between 05:00 and 11:00." Undo into it is refused the same way. The rule is `HouseSim.windowState` in `sim.js`, which mirrors the template in `moods_core.yaml`: `from` inclusive, `to` exclusive, midnight crossing, and a malformed window runs the mood (and is logged). The clock is real time unless `--clock HH:MM` or `/control/clock` pins it. In mock mode the page's `?time=` pins it.
  - It stops other running moods.
  - Each mood script is `mode: restart`: starting a mood that is still running stops its earlier run first, before `mood_begin` decides, so a re-tap that is refused (Good Morning tapped again after 11:00 while still rising) leaves the earlier run stopped, as on the box.
  - It moves current to previous, but not when the current mood is re-run.
  - The slug comes from the script's entity id, as in the package; `mood_slug` plays no part.
  - A `script.turn_on` on a missing script succeeds and does nothing (HA only logs it).
  - Each touch entity reaches its expected state after a realistic delay: lights 0.7 to 1.8 s, switches 0.5 to 1.3 s, mirrors (`binary_sensor`) 1.8 to 4 s, speakers 1.5 to 3 s.
  - `light.role_all_lights` follows the other light roles.
- **One entity never answers** (default `light.role_patio_lights`, Afterglow's and Hosting's Patio mark).
- **The settings helpers** from `moods_settings.yaml` (every `input_select:` there) exist at their first option, as on a freshly deployed box. Change one with `/control/set`, for example the bedroom panel's `input_select.moods_panel_bedroom_night_hours`, or remove it with `/control/remove`.

Control endpoints on the same port:

| GET | Effect |
| --- | --- |
| `/control/state` | Current mood, previous, notice, connection count, every entity's state |
| `/control/calls` | Every `call_service` received (`?clear=1` empties the list) |
| `/control/drop` | Destroys every socket (no close frame), like a Wi-Fi drop |
| `/control/stall?ms=40000` | The sockets open now stop answering (pings included) and stay open: a half-open link. Their inbound messages are held and delivered when the stall ends, if the socket is still open. A socket opened during the stall is a fresh link: it gets `auth_required` at once and works normally, as with real HA |
| `/control/lag?ms=10000&for=2000` | What the sockets open now send during the next `for` ms reaches the phone `ms` late, in order (what follows waits behind it), while the phone's own messages reach HA at once: Wi-Fi holding inbound packets. A socket opened later is not lagged |
| `/control/refuse?ms=5000` | Refuses new connections, like HA restarting |
| `/control/outside?slug=focus` | Something else sets a mood (voice, the other phone); with no slug, a random one |
| `/control/never?entity=ID` | Changes the entity that never answers (`entity=` for none) |
| `/control/vacation?on=1` | Turns vacation mode on or off |
| `/control/clock?at=07:30` | Pins the house's local time (hours and minutes) that mood time windows are checked against; `at=` with no value goes back to real time. `/control/state` reports it as `clock` |
| `/control/remove?entity=ID` | Removes an entity (a helper that is gone) |
| `/control/set?entity=ID&state=S`, `/control/temp?value=71` | Set any state, or the temperature (`&entity=climate.thermostat` sets that thermostat's `current_temperature`; the fake always has one, in `heat_cool`) |
| `/control/noop?entity=script.mood_focus&on=1` | That mood script runs but never calls `mood_begin` (a file missing its first two steps): the call succeeds and `house_mood` never moves. `on=0` undoes it |
| `/control/reload?dir=PATH` | A script reload: removes every mood script, then creates them again from `PATH` (default: the folder loaded at start). Use a copy of `ha/packages/moods` plus a new file to try a mood before deploying it |

`node ui/dev/mood-yaml.js --check [dir]` compares the reader with PyYAML (through `uv`) for every file in `dir` (default `ha/packages/moods`): the customize blocks and the `input_select:` helpers.

## Tools

The page needs a static server on port 8766 serving `ui/`, for example `python3 -m http.server 8766 -d ui`.

| Command | What it does |
| --- | --- |
| `node ui/dev/drive.js` | The full end-to-end run. It starts its own fake HA and loads the page in shell mode, with a stand-in `window.Shell` that records every bridge call. Then it holds, confirms, undoes, misses a mark, gets refused, sees an outside change, loses and regains the connection (dropped, refused and half-open, including a hold sent into a half-open link, and a mood HA sets while its answer is 10 s late staying on the face), gains and loses a mood through a script reload without a page reload, sends power, net and sensor events, and checks the night face (including a deck opened from the Lights Out night face staying at the night level), the five-tap escape and a thermostat as `tempEntity`. Time windows: it checks the window rule's boundaries in node, and on `sim.js` that a re-tap after 11:00 of a Good Morning still rising is refused and stops the earlier run (`mode: restart`), then, on the fake's pinned clock, that Good Morning is refused at 21:18 (vacation's reason wins when both apply), runs at 07:30, and that an Undo into it at 11:00 is refused. It checks this panel's settings from the dashboard: the fake's helpers at their first option leave the phone on its own config; "Dimmer (70%)" and "Brighter (140%)" scale the day level; "21:00 to 06:00" brings night at 21:18 (night levels unchanged); "No night hours" overrides the config's hours, also straight after a reload; and an out-of-range, unavailable, malformed, first-option or removed helper, or a screen option with a decimal or a sign ("Dimmer (70.5%)", "Dimmer (-70%)"), falls back to the config's hours and the usual levels. Last it checks the same refusal and acceptance in mock mode with `?time=`. It prints PASS/FAIL per check and writes `ui/dev/shots/ui-fake-*.png`. `SKIP_STALL=1` and `SKIP_LUX=1` skip the slow checks (about 80 s and 40 s); `DRIVE_W=424 DRIVE_H=753` runs it on the larger phone size |
| `node ui/dev/shots.js [base] [out] [filter]` | Reference stills at 360x640 and 424x753 in exact viewports, written to `ui/dev/shots/ui-*.png` (git-ignored). `SHOT_EXTRA="ha=ws://127.0.0.1:8767/api/websocket&token=test-token" SHOT_PREFIX=ui-fakedirect` renders against the fake instead of mock mode; there the applied shots do a real hold, since `state=applied` never changes a real house. |
| `node ui/dev/cdp.js shot <url> <out.png> [w h wait]` | One screenshot over DevTools, in real time |
| `ui/dev/shot.sh <name> "<params>" [w h budget out]` | The mockup's iframe and virtual-time method, for static stills only (timers may not advance) |
| `node ui/dev/lint.js` | Checks for what Chrome 101 on the Adreno 505 cannot do, or must not do: `:has`, container queries, `color-mix`, dynamic viewport units, viewport-height sizing, view transitions, `text-wrap`, `backdrop-filter`, `linear()`, CSS nesting, canvas/WebGL, modules, `fetch`/XHR, iframes, remote URLs, post-101 JS built-ins, console logging, and transitions or keyframes on anything but transform and opacity. It also checks that every `mood_glyph` in `ha/packages/moods` has a glyph; that the five approved mockup accents, inks and skies come through `Moods.palette()`/`Moods.sky()` unchanged, both as `mock.js` carries them and as the package files do; that every other package mood's hand-tuned sky is not clamped or dropped; and that `mock.js`'s five demo moods carry exactly the package's attributes. It also checks the approved card text of every package mood (`APPROVED_TEXT`), that no card promises music or the guest room, and that every `mood_window` is well-formed and approved (`APPROVED_WINDOWS`: today only Good Morning). For the settings in `moods_settings.yaml` it checks that each mood's first option ("Usual (...)") carries exactly the fallbacks in the mood's reader step, that every option has the count of numbers the reader expects, each inside its range, that every option is a quoted string, that no `input_select.moods_*` setting is left unread, and that the panel settings are options the UI understands |

The DevTools tools launch headless Chrome with a fresh `--user-data-dir` and set the viewport with `Emulation.setDeviceMetricsOverride` (DPR 2). Plain `--window-size` does not give an exact viewport.

## Adding to the look

- **A new glyph:** draw it in a 64x64 box, with round caps and the light source where the halo is, and add it to `glyphs.js` under its key. Moods using an unknown key show the neutral `ember` glyph meanwhile.
- **A new mood's palette:** `glows` are `[lamp, band, counter-light]`:
  - **Lamp:** the dominant low glow behind the lower centre (small and faint for a `mood_night` mood).
  - **Band:** a broad soft field high on the wall.
  - **Counter-light:** a faint glow in a corner; neighbouring cards use different corners. A grey one about as dark as the room is left out.

  Strength comes from luminance, so pale colours stay dim. `accent` colours the glyph, rings, marks and the "On now" flag; it is lightened only if its luminance is under 100. `ink` (optional) colours the clock and the name; without it a cream is derived from the accent. `base` is the room's dark plaster, darkened if too bright.
- **A hand-tuned sky:** `mood_palette.sky` replaces the generated one: up to four `[kind, "#rrggbb", alpha, width, height, x%, y%, drift]` layers (`kind` band, lamp or glow; sizes in u; drift 1 to 3), drawn in order. Values are clamped (alpha at most 0.62, and alpha times the colour's luminance at most 100). The five Ember moods carry their approved skies this way, in the package files and in `mock.js`; Focus carries a hand-tuned bright, cool one (its lamp is at about 89 of that 100). `lint.js` reports any package sky the UI would clamp.

  Check a new palette with `?mock=1`, or against the fake HA after adding the mood file.
