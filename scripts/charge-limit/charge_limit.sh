#!/system/bin/sh
# Palm battery guard: keep charge between LOW and HIGH, pause charging when hot.
# Tunables live in /data/adb/charge_limit.conf (LOW=, HIGH=, HOT=, COOL=).
LOW=40; HIGH=80; HOT=420; COOL=380   # temps in tenths of a degree C
B=/sys/class/power_supply/battery
SW=$B/battery_charging_enabled
LOG=/data/adb/charge_limit.log
PIDF=/data/adb/charge_limit.pid
log() { echo "$(date '+%F %T') $*" >> $LOG; tail -n 500 $LOG > $LOG.tmp && mv $LOG.tmp $LOG; }
# Single instance: stop a previous copy (e.g. when reinstalling without a reboot).
old=$(cat $PIDF 2>/dev/null)
if [ -n "$old" ] && [ "$old" != "$$" ] && grep -q charge_limit /proc/$old/cmdline 2>/dev/null; then
  kill "$old"; pkill -P "$old" 2>/dev/null   # also end its `sleep`, or sh waits it out
fi
echo $$ > $PIDF
until [ "$(getprop sys.boot_completed)" = 1 ]; do sleep 5; done
log "started"
while true; do
  [ -f /data/adb/charge_limit.conf ] && . /data/adb/charge_limit.conf
  cap=$(cat $B/capacity); t=$(cat $B/temp); cur=$(cat $SW)
  want=$cur
  if [ "$t" -ge "$HOT" ]; then want=0
  elif [ "$cap" -ge "$HIGH" ]; then want=0
  elif [ "$cap" -le "$LOW" ] && [ "$t" -le "$COOL" ]; then want=1
  fi
  if [ "$want" != "$cur" ]; then echo $want > $SW; log "cap=$cap temp=$t charging=$want"; fi
  sleep 60
done
