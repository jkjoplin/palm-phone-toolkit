#!/usr/bin/env bash
# Install charge_limit.sh on a rooted Palm (or similar) over adb.
set -euo pipefail
cd "$(dirname "$0")"
ADB="adb ${ANDROID_SERIAL:+-s $ANDROID_SERIAL}"

$ADB shell 'su -c id' | grep -q 'uid=0' || {
  echo "No root over adb. In Magisk, open the Superuser tab and enable Shell." >&2; exit 1; }

$ADB shell 'su -c "test -e /sys/class/power_supply/battery/battery_charging_enabled"' || {
  echo "battery_charging_enabled not found; this device needs a different switch." >&2; exit 1; }

$ADB push charge_limit.sh /data/local/tmp/charge_limit.sh >/dev/null
$ADB shell 'su -c "mkdir -p /data/adb/service.d && cp /data/local/tmp/charge_limit.sh /data/adb/service.d/charge_limit.sh && chmod 755 /data/adb/service.d/charge_limit.sh"'
$ADB shell 'su -c "nohup sh /data/adb/service.d/charge_limit.sh >/dev/null 2>&1 &"' || true
sleep 3
$ADB shell 'su -c "tail -n 5 /data/adb/charge_limit.log"'
echo "Installed. It will start automatically on every boot."
