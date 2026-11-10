# Back up and root a PVG100 from Linux

Tested November 2026 on a US PVG100 (Android 8.1, March 2019 patch) from an Arch-based laptop, using [bkerler/edl](https://github.com/bkerler/edl) at commit `1cda1a6` and Magisk v31.1. macOS may work, but Linux is the better-trodden path for EDL.

**This wipes the phone.** After you flash a patched boot image, full-disk encryption can no longer unlock user data, so you'll have to factory reset.

## 0. Prerequisites

- `adb`, `git`, Python 3 and [`uv`](https://github.com/astral-sh/uv) (or pip)
- USB debugging turned on and the computer authorized (see [identify.md](identify.md))
- About 8 GB of free disk space for the backup

## 1. Set up edl

```bash
git clone https://github.com/bkerler/edl.git && cd edl
git submodule update --init --depth 1        # pulls the Loaders collection
git apply /path/to/palm-phone-toolkit/patches/edl-firehose-pepito.patch
uv sync
mkdir -p logs                                 # --debugmode crashes without it
```

Linux USB permissions (one time):

```bash
sudo cp Drivers/51-edl.rules Drivers/50-android.rules /etc/udev/rules.d/
sudo cp Drivers/blacklist-qcserial.conf /etc/modprobe.d/
sudo udevadm control -R && sudo udevadm trigger
```

### Why the patch?

The Palm's firehose loader sends read data without first sending the `rawmode="true"` response that stock edl waits for, so reads hang at "Trying to read first storage sector…". The `--skipresponse` flag fixes reads, but applied to writes it leaves a stray ACK in the pipe that wedges the next session. The patch makes reads always skip the response and leaves writes alone, so you can run **without** `--skipresponse`. It also fixes a str/bytes crash in `cmd_read_buffer`.

## 2. Enter EDL and check the partition table

```bash
adb reboot edl
lsusb | grep 05c6:9008                        # should show Qualcomm QDL mode
uv run edl.py printgpt --memory=eMMC --sectorsize=512
```

edl picks `Loaders/TCL/0006b0e100420041_073e81231dae45ba_fhprg_peek.bin` automatically. `--sectorsize=512` is required, because the default of 4096 fails.

## 3. Full backup (do not skip)

```bash
mkdir -p ~/palm-backup
uv run edl.py rl ~/palm-backup --memory=eMMC --sectorsize=512 --skip=userdata --genxml
cd ~/palm-backup && sha256sum *.bin > SHA256SUMS
```

This takes about 10 minutes at roughly 14 MB/s and comes to about 7.4 GB across 53 partitions. `userdata` is skipped because it's encrypted and gets wiped anyway. Check that every file's size matches the `printgpt` output.

To restore any partition later: `uv run edl.py w <name> ~/palm-backup/<name>.bin --memory=eMMC --sectorsize=512`.

## 4. Get back to Android

```bash
uv run edl.py reset
```

If that hangs (it often does after a read or write), **hold the power button for about 15 seconds**.

## 5. Patch boot with Magisk (on the phone, no UI needed)

Download `Magisk-v31.1.apk` from the [official releases](https://github.com/topjohnwu/Magisk/releases). Then:

```bash
mkdir x && cd x && bsdtar -xf ../Magisk-v31.1.apk assets lib/arm64-v8a
mkdir push
cp assets/boot_patch.sh assets/util_functions.sh push/
L=lib/arm64-v8a
cp $L/libmagiskboot.so push/magiskboot; cp $L/libmagiskinit.so push/magiskinit
cp $L/libmagisk.so push/magisk;         cp $L/libinit-ld.so push/init-ld
cp $L/libbusybox.so push/busybox
cp ~/palm-backup/boot.bin push/boot.img

adb push push /data/local/tmp/mp
adb shell "cd /data/local/tmp/mp && chmod 755 * && \
  KEEPFORCEENCRYPT=true KEEPVERITY=false ./busybox sh boot_patch.sh boot.img"
adb pull /data/local/tmp/mp/new-boot.img magisk-boot.img
adb install Magisk-v31.1.apk
```

The output should end with `Repack to boot image: [new-boot.img]`. "Failed to patch" lines about the dtb fstab are harmless.

## 6. Flash and verify

```bash
adb reboot edl
uv run edl.py w boot magisk-boot.img --memory=eMMC --sectorsize=512
uv run edl.py r boot readback.img --memory=eMMC --sectorsize=512
sha256sum magisk-boot.img readback.img       # must match before you reboot
```

Then hold power for about 15 seconds to reboot.

## 7. First boot

1. You'll see an orange "different OS" warning. That's normal, and `ro.boot.verifiedbootstate` now reads `yellow`.
2. The phone asks for a **password** to start Android. That's the encryption breaking, as expected. Hold power until it's off, hold it again through the restarts to reach recovery, then choose **Wipe data/factory reset** → **Reboot system now**.
3. Set the phone up, turn USB debugging back on, and reinstall the Magisk app (`adb install Magisk-v31.1.apk`). Open it and accept the reboot it asks for.
4. Run `adb shell su -c id`. If it returns "Permission denied", open Magisk → **Superuser** tab and switch on **Shell**.

You're rooted. Next, install the [charge limiter](../scripts/charge-limit/).
