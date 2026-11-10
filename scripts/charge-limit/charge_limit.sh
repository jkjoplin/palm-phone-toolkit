#!/system/bin/sh
# Palm battery guard: keep charge between LOW and HIGH, pause charging when hot.
# Tunables live in /data/adb/charge_limit.conf (LOW=, HIGH=, HOT=, COOL=).
LOW=40; HIGH=80; HOT=420; COOL=380   # temps in tenths of a degree C
B=/sys/class/power_supply/battery
SW=$B/battery_charging_enabled
LOG=/data/adb/charge_limit.log
log() { echo "$(date '+%F %T') $*" >> $LOG; tail -n 500 $LOG > $LOG.tmp && mv $LOG.tmp $LOG; }
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
