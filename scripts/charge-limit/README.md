# charge-limit

A Magisk `service.d` script that keeps a rooted Palm's battery between **40% and 80%** and pauses charging when the battery reaches **42 °C**. It's for phones that stay plugged in as dashboards or sensors.

It flips `/sys/class/power_supply/battery/battery_charging_enabled` (qpnp-smbcharger driver). While charging is paused, the phone runs from its battery even though USB is connected, which is the point.

## Install (needs root over adb)

```bash
./install.sh            # pushes the script, starts it, and prints the log
```

Or by hand:

```bash
adb push charge_limit.sh /data/local/tmp/
adb shell su -c 'mkdir -p /data/adb/service.d && cp /data/local/tmp/charge_limit.sh /data/adb/service.d/ && chmod 755 /data/adb/service.d/charge_limit.sh'
adb reboot
```

Magisk runs everything in `/data/adb/service.d/` on each boot.

## Configure

Create `/data/adb/charge_limit.conf` to override the defaults. Changes are picked up within a minute:

```sh
LOW=40     # resume charging at or below this %
HIGH=80    # stop charging at or above this %
HOT=420    # pause at or above 42.0 °C (tenths of a degree)
COOL=380   # after a heat pause, resume once at or below 38.0 °C
FLOOR=25   # under this %, charge even while warm (never at HOT or above)
```

## Check it

```bash
adb shell su -c 'cat /data/adb/charge_limit.log'
adb shell su -c 'cat /sys/class/power_supply/battery/{capacity,status,temp,battery_charging_enabled}'
```

## Uninstall

```bash
adb shell su -c 'rm /data/adb/service.d/charge_limit.sh; echo 1 > /sys/class/power_supply/battery/battery_charging_enabled'
```

## Other devices

Many Qualcomm phones of the same era use the same driver. If yours doesn't have `battery_charging_enabled`, look for `charging_enabled` or `input_suspend` (where `input_suspend=1` stops charging). PRs that add auto-detection are welcome.
