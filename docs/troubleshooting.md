# Troubleshooting

## edl hangs at "Trying to read first storage sector…"
The loader sends data before its response. Apply [the patch](../patches/edl-firehose-pepito.patch), or pass `--skipresponse` for read-only commands. Also pass `--memory=eMMC --sectorsize=512`.

## `TypeError: a bytes-like object is required, not 'str'` in `cmd_read_buffer`
This is the same root cause, and the patch fixes it.

## "Sector size in XML 4096 does not match disk sector size 512"
Add `--sectorsize=512`.

## edl hangs at "Mode detected: firehose" and nothing answers
The session is wedged, usually after a write that used `--skipresponse`, after an interrupted transfer, or after a few sessions in a row. Further commands won't fix it, and if a write was cut off midway they can corrupt the partition being written. **Hold power for about 15 seconds** to leave EDL, get back in with `adb reboot edl`, then repeat the write and **verify it with a readback** before booting.

## Stuck on a "No command" screen (Android lying on its back)
This is stock recovery waiting for input. The Palm has no volume keys, so the usual Power + Volume Up shortcut doesn't exist. Pressing and holding the power button a few more times eventually brings up the recovery menu, but the exact sequence isn't pinned down yet. **If you find a reliable one, please open a PR.**

## Power button does nothing and the screen stays black
The phone is probably still in EDL (`lsusb` shows `05c6:9008`). EDL has no display, and the power button may not get you out of it. Run `edl.py reset` from the computer. If that hangs after a patched read, see the next section.

## `edl.py reset` hangs
Older versions of this repo's patch forced every read to skip the response, which broke the sector-size probe that `reset` runs. The current patch only does that when the sector size is 512. With the old patch, swap in the original `firehose.py`, run `reset`, then swap the patched one back.

## No adb, need EDL
- From Android or recovery: `adb reboot edl`.
- Without adb: hold power through the restarts into stock recovery (reports say about 30 seconds), which offers an emergency download / EDL option. Only `boot` changes during rooting, and recovery stays intact.
- As a last resort, use a deep-flash (EDL) USB cable.

## Asks for a password after flashing Magisk
This is expected with full-disk encryption: the boot image changed, so user data won't unlock. Factory reset from recovery. Typing `default_password` sometimes works, but don't count on it.

## `su -c id` → Permission denied
Open Magisk → **Superuser** tab → switch on **Shell**. If the app was uninstalled by the factory reset, reinstall it first.

## `ls: /sys/class/power_supply/battery/: Permission denied`
The battery files need root. Use `su -c`.

## `edl.py --debugmode` crashes with FileNotFoundError on logs/log.txt
Run `mkdir logs` in the edl folder.
