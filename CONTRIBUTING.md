# Contributing

Thanks for helping keep these little phones useful. All kinds of contributions are welcome:

- **Scripts** for the phone (Magisk `service.d`, Termux, Tasker exports) go in `scripts/<name>/`, each with its own `README.md`.
- **Home Assistant** dashboards, automations and Companion app tips go in `homeassistant/`.
- **Mounts and stands** (STL / 3MF / STEP, plus a photo) go in `prints/`.
- **Docs**: corrections, other models (PVG100E!), macOS or Windows instructions, and new troubleshooting entries.

## Guidelines

- Say which model, Android build and tool versions you tested on.
- Never commit device serials, IMEIs, account names, Wi-Fi details, hostnames or partition dumps. Firmware images aren't ours to redistribute, so link to the sources instead.
- Scripts that write to `/sys` or flash should check what they're about to touch and fail safely.
- Keep it friendly. Lots of people here are touching EDL for the first time.

## Reporting a problem

Open an issue with your model (`adb shell getprop ro.product.model`), what you ran and the full output.
