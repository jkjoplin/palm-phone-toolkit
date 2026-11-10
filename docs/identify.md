# Identify your Palm

"Palm phone" can mean three very different devices:

| Device | Years | OS | How to talk to it |
| --- | --- | --- | --- |
| Treo / Centro | 2002–2009 | Palm OS or Windows Mobile | HotSync, serial |
| Pre / Pixi / Veer | 2009–2011 | webOS | `novacom` |
| **Palm (PVG100 / PVG100E)** | 2018 | Android 8.1 / 9 | `adb`, Qualcomm EDL |

This repo covers the 2018 one.

## Over USB, before USB debugging is on

On macOS, run `system_profiler SPUSBDataType`. On Linux, run `lsusb`.

- Vendor `0x1bbb` (TCL / "T & A Mobile Phones") means it's the 2018 Palm.
- Product `0xa00e` is file-transfer (MTP) only, and `0xa00f` is MTP plus adb.
- `05c6:9008` (Qualcomm QDL) means the phone is in EDL mode.

## With adb

Turn on USB debugging: Settings → About phone → tap **Build number** 7 times → Developer options → **USB debugging**. Then:

```bash
adb shell getprop ro.product.model          # PVG100 or PVG100E
adb shell getprop ro.build.fingerprint
adb shell getprop ro.build.version.security_patch
adb shell getprop ro.boot.flash.locked      # 1 = locked
adb shell dumpsys battery
```

US Verizon units report `Palm/PVG100/Pepito:8.1.0/OPM1.171019.019/...`. **Don't cross-flash between PVG100 and PVG100E.** Their partition layouts differ.
