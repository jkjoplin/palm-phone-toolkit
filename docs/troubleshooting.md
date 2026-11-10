# Troubleshooting

## edl hangs at "Trying to read first storage sector…"
The loader sends data before its response. Apply [the patch](../patches/edl-firehose-pepito.patch), or pass `--skipresponse` for read-only commands. Also pass `--memory=eMMC --sectorsize=512`.

## `TypeError: a bytes-like object is required, not 'str'` in `cmd_read_buffer`
This is the same root cause, and the patch fixes it.

## "Sector size in XML 4096 does not match disk sector size 512"
Add `--sectorsize=512`.

## edl hangs at "Mode detected: firehose" and nothing answers
The session is wedged, usually after a write that used `--skipresponse`, after an interrupted transfer, or after a few sessions in a row. Further commands won't fix it, and if a write was cut off midway they can corrupt the partition being written. **Hold power for about 15 seconds** to leave EDL, get back in with `adb reboot edl`, then repeat the write and **verify it with a readback** before booting.

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
