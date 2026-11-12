# Ideas

These are ways to use a Palm around the house, easiest first. PRs that turn any of them into a working recipe are very welcome.

| Idea | Difficulty | Notes |
| --- | --- | --- |
| Home Assistant remote | Easy | HA Companion app, or a kiosk browser on a dashboard sized for 720×1280. Lights, scenes, thermostat. For a ready-made mood controller, see [moods/](../moods/). |
| 3D printer monitor | Easy | An HA dashboard with the printer's camera, progress and time left. Mount it next to the printer. |
| Battery and health sensors in HA | Easy | Companion app sensors: battery, charging, temperature. |
| Always-on alert pager | Medium | Tasker or a small script polls HA or an agent and shows or announces alerts. |
| Pocket chat client for a home AI agent | Medium | A small web UI served on your LAN, plus HA Assist for voice. |
| Headless camera or mic node | Medium–hard | Termux plus a tiny server. Use the [charge limiter](../scripts/charge-limit/). |
| LineageOS / GSI | Hard | See the LineageOS and Treble threads linked in the README. Gets you a newer Android. |

**No NFC.** The US PVG100 has no NFC service or hardware feature (`pm list features` shows none), so tap-a-tag triggers are not possible.

## Always plugged in? Protect the battery

Lithium batteries kept at 100% and warm are the ones that swell. On a rooted Palm, use [scripts/charge-limit](../scripts/charge-limit/). Without root, have HA switch a smart plug: off at 80%, on at 40%, using the Companion app's battery sensor.
