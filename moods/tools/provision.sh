#!/usr/bin/env bash
# Provision one Palm phone as a Moods panel (docs/ARCHITECTURE.md section 4).
#
#   tools/provision.sh <adb-serial> <panel> [options]
#
# Installs the APK, makes Moods the home app, disables the keyguard and the double-press
# camera gesture, resets any density override, installs the charge guard, and last pushes
# config.json and starts Moods. Every change, and the command that undoes it, is in
# tools/README.md.
# The phone's values from before the first run are saved in tools/state/<serial>.env.
#
# The token is never printed. Run it again at any time: each step is idempotent.
set -euo pipefail

PKG=com.palmmoods.shell
ACTIVITY=$PKG/.KioskActivity
DEVICE_CONFIG_DIR=/sdcard/Android/data/$PKG/files
TOOLS="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$TOOLS")"

usage() {
  cat <<EOF
Usage: $0 <adb-serial> <panel> [options]

  <adb-serial>   from 'adb devices', e.g. a1b2c3d4
  <panel>        panel name for this phone, e.g. bedroom

Options:
  --apk FILE           default: shell/app/build/outputs/apk/debug/app-debug.apk
  --config FILE        default: tools/config.<panel>.json (copy tools/config.example.json)
  --charge-guard FILE  default: \$CHARGE_GUARD, else scripts/charge-limit/charge_limit.sh in this toolkit
  --skip-charge-guard  leave the charge guard alone (also skips the root check)
  -h, --help
EOF
}

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

[ $# -ge 2 ] || { usage >&2; exit 2; }
SERIAL=$1; PANEL=$2; shift 2
APK="$REPO/shell/app/build/outputs/apk/debug/app-debug.apk"
CONFIG="$TOOLS/config.$PANEL.json"
GUARD="${CHARGE_GUARD:-$(dirname "$REPO")/scripts/charge-limit/charge_limit.sh}"
SKIP_GUARD=0
while [ $# -gt 0 ]; do
  case $1 in
    --apk) APK=$2; shift 2 ;;
    --config) CONFIG=$2; shift 2 ;;
    --charge-guard) GUARD=$2; shift 2 ;;
    --skip-charge-guard) SKIP_GUARD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
[[ $PANEL =~ ^[a-z0-9_-]+$ ]] || die "panel must be lowercase letters, digits, - or _"

adb_() { adb -s "$SERIAL" "$@"; }
# adb shell, with CR stripped (older adb versions add it).
sh_() { adb -s "$SERIAL" shell "$@" | tr -d '\r'; }

# ---- preflight: nothing on the phone changes until all of this passes -------------------
step "Preflight"
command -v adb >/dev/null || die "adb not found"
command -v python3 >/dev/null || die "python3 not found (used to check and finish config.json)"
[ -f "$TOOLS/check_config.py" ] || die "tools/check_config.py is missing"
[ "$(adb_ get-state 2>/dev/null || true)" = device ] || die "device $SERIAL is not connected (see 'adb devices')"
[ -f "$APK" ] || die "APK not found: $APK (build it: cd shell && ./gradlew assembleDebug)"
[ -f "$CONFIG" ] || die "config not found: $CONFIG (copy tools/config.example.json and fill it in)"
if [ $SKIP_GUARD = 0 ]; then
  [ -f "$GUARD" ] || die "charge guard not found: $GUARD (pass --charge-guard FILE or --skip-charge-guard)"
  sh_ 'su -c id' 2>/dev/null | grep -q 'uid=0' ||
    die "no root over adb (Magisk > Superuser > enable Shell), or pass --skip-charge-guard"
  sh_ 'su -c "test -e /sys/class/power_supply/battery/battery_charging_enabled && echo ok"' | grep -q ok ||
    die "battery_charging_enabled not found; this phone needs a different charge switch"
fi
SDK=$(sh_ getprop ro.build.version.sdk)
MODEL=$(sh_ getprop ro.product.model)
echo "device $SERIAL: $MODEL, SDK $SDK"
[ "$SDK" = 27 ] || echo "warning: built and tested for SDK 27 (Android 8.1); this phone is SDK $SDK"

# Finish config.json in a private temp file: set the panel, default the device name,
# and check it with the app's own rules (tools/check_config.py mirrors ShellConfig.parse;
# shared cases in tools/config-cases.json). Prints only key names, never the token.
umask 077
TMP_CONFIG=$(mktemp "${TMPDIR:-/tmp}/moods-config.XXXXXX")
TMP_HELPER=$(mktemp "${TMPDIR:-/tmp}/moods-guard.XXXXXX")
trap 'rm -f "$TMP_CONFIG" "$TMP_HELPER"' EXIT
python3 -I "$TOOLS/check_config.py" "$CONFIG" "$PANEL" "$TMP_CONFIG"

# ---- record what the phone had before the first run --------------------------------------
STATE_DIR="$TOOLS/state"
STATE="$STATE_DIR/$SERIAL.env"
if [ ! -f "$STATE" ]; then
  step "Recording the phone's current settings in tools/state/$SERIAL.env"
  mkdir -p "$STATE_DIR"
  home=$(sh_ cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME | tail -n 1 || true)
  keyguard=$(sh_ locksettings get-disabled 2>/dev/null | tail -n 1 || true)
  case $keyguard in true|false) ;; *) keyguard=unknown ;; esac
  camera=$(sh_ settings get secure camera_double_tap_power_gesture_disabled || true)
  density=$(sh_ wm density | sed -n 's/^Override density: *//p' || true)
  guard_before=$(sh_ 'su -c "test -f /data/adb/service.d/charge_limit.sh && echo yes || echo no"' 2>/dev/null || echo unknown)
  case $guard_before in yes|no) ;; *) guard_before=unknown ;; esac
  {
    echo "# $SERIAL ($MODEL) before Moods provisioning, $(date '+%F %T')"
    case ${home:-unknown} in
      *ResolverActivity*|unknown)
        echo "# No single home app was set before (or it could not be read): undo with the Palm launcher, com.tct.pepitolauncher/.LauncherActivity" ;;
    esac
    echo "HOME_ACTIVITY=${home:-unknown}"
    echo "KEYGUARD_DISABLED=${keyguard:-unknown}"
    echo "CAMERA_GESTURE_DISABLED=${camera:-null}"
    echo "DENSITY_OVERRIDE=${density:-none}"
    echo "CHARGE_GUARD_INSTALLED=$guard_before"
  } > "$STATE"
  cat "$STATE"
else
  echo "tools/state/$SERIAL.env already exists; keeping the values from the first run"
  # A first run without root could not tell whether a charge guard was there. Nothing of
  # ours has been installed since (that needs root), so look again now that root works.
  if [ $SKIP_GUARD = 0 ] && ! grep -Eq '^CHARGE_GUARD_INSTALLED=(yes|no)$' "$STATE"; then
    guard_before=$(sh_ 'su -c "test -f /data/adb/service.d/charge_limit.sh && echo yes || echo no"' 2>/dev/null || echo unknown)
    case $guard_before in
      yes|no)
        grep -v '^CHARGE_GUARD_INSTALLED=' "$STATE" > "$STATE.tmp" || true
        echo "CHARGE_GUARD_INSTALLED=$guard_before" >> "$STATE.tmp"
        mv "$STATE.tmp" "$STATE"
        echo "recorded CHARGE_GUARD_INSTALLED=$guard_before (it was unknown)"
        ;;
    esac
  fi
fi

# ---- changes ------------------------------------------------------------------------------
step "1. Install $(basename "$APK")"
adb_ install -r "$APK"

step "2. Make Moods the home app"
sh_ cmd package set-home-activity "$ACTIVITY"

step "3. Disable the keyguard (swipe lock)"
sh_ locksettings set-disabled true

step "4. Disable the double-press-power camera gesture"
sh_ settings put secure camera_double_tap_power_gesture_disabled 1

step "5. Reset any display density override"
sh_ wm density reset

if [ $SKIP_GUARD = 0 ]; then
  step "6. Install the charge guard ($(basename "$GUARD"))"
  # Runs on the phone as root. It stops every running copy first: older copies have no
  # single-instance guard and would keep running beside the new one.
  # Back up the phone's own copy once, unless the state file says it had none before Moods
  # (then a copy found now is ours from an earlier run). Unknown counts as "maybe had one".
  if grep -q '^CHARGE_GUARD_INSTALLED=no$' "$STATE"; then echo "BACKUP=0" > "$TMP_HELPER"; else echo "BACKUP=1" > "$TMP_HELPER"; fi
  cat >> "$TMP_HELPER" <<'SH'
set -e
D=/data/adb/service.d
mkdir -p $D
if [ "$BACKUP" = 1 ] && [ -f $D/charge_limit.sh ] && [ ! -f /data/adb/charge_limit.sh.before-moods ]; then
  cp $D/charge_limit.sh /data/adb/charge_limit.sh.before-moods
fi
cp /data/local/tmp/charge_limit.sh $D/charge_limit.sh
chmod 755 $D/charge_limit.sh
for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  [ "$pid" = "$$" ] && continue
  if grep -q 'charge_limit\.sh' "$p/cmdline" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
done
rm -f /data/adb/charge_limit.pid
nohup sh $D/charge_limit.sh >/dev/null 2>&1 &
rm -f /data/local/tmp/charge_limit.sh /data/local/tmp/moods-guard.sh
SH
  adb_ push "$GUARD" /data/local/tmp/charge_limit.sh >/dev/null
  adb_ push "$TMP_HELPER" /data/local/tmp/moods-guard.sh >/dev/null
  sh_ 'su -c "sh /data/local/tmp/moods-guard.sh"'
  sleep 3
  sh_ 'su -c "tail -n 3 /data/adb/charge_limit.log"' || true
else
  step "6. Charge guard skipped"
fi

# ---- config last, then start and check ------------------------------------------------
# Pushed last and started at once, so the token spends as little time as possible on
# shared storage. The app imports it into private storage and deletes the file; on any
# problem it deletes the file too and logs one line, which is what decides the result here.
step "7. Push config.json and start Moods"
CFG_DEV="$DEVICE_CONFIG_DIR/config.json"
remove_pushed() { sh_ "rm -f '$CFG_DEV' '$CFG_DEV.bad'" >/dev/null 2>&1 || true; }
# The phone's clock, so only this run's log lines count.
since=$(sh_ "date '+%m-%d %H:%M:%S.000'")
sh_ mkdir -p "$DEVICE_CONFIG_DIR" || true
if ! adb_ push "$TMP_CONFIG" "$CFG_DEV" >/dev/null 2>&1; then
  echo "push failed; starting the app once so it creates its own folder, then retrying"
  adb_ shell am start -n "$ACTIVITY" >/dev/null
  sleep 3
  adb_ push "$TMP_CONFIG" "$CFG_DEV" >/dev/null
fi
# Push first, then stop: whichever start comes next (the system relaunching its home app,
# or the am start below) runs onCreate with the file already there.
adb_ shell am force-stop "$PKG"
adb_ shell am start -W -n "$ACTIVITY" >/dev/null

result=unknown
applog=""
deadline=15
waited=0
while [ $waited -lt $deadline ]; do
  applog=$(sh_ "logcat -d -T '$since' -s Moods" 2>/dev/null || true)
  if grep -q 'Rejected config\.json' <<<"$applog"; then result=rejected; break; fi
  if grep -Eq 'Imported config|Config unchanged' <<<"$applog"; then result=ok; break; fi
  # After a recent crash the app waits out its back-off (up to 2 min) before importing.
  if [ $deadline = 15 ] && grep -q 'Recent crash: starting up in' <<<"$applog"; then
    deadline=135
    echo "Moods crashed recently and is waiting out its back-off; waiting up to 2 min"
  fi
  sleep 1
  waited=$((waited + 1))
done
leftover=$(sh_ "ls '$CFG_DEV' '$CFG_DEV.bad' 2>/dev/null" || true)
[ -z "$leftover" ] || remove_pushed

case $result in
  ok)
    # The app logs the config with the token masked.
    grep -E 'Imported config|Config unchanged' <<<"$applog" | tail -n 1
    [ -z "$leftover" ] || echo "note: the app could not delete the pushed file; it was wiped and is now removed"
    ;;
  rejected)
    grep 'Rejected config\.json' <<<"$applog" | tail -n 1 >&2
    die "the app rejected config.json and kept its previous config (the pushed file is removed). Fix $CONFIG and run again."
    ;;
  *)
    adb_ logcat -d -s Moods 2>/dev/null | tail -n 5 || true
    die "could not confirm the import within $deadline s (pushed file removed). Check: adb -s $SERIAL logcat -d -s Moods"
    ;;
esac
echo
echo "home activity now: $(sh_ cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME | tail -n 1)"
echo "Done. To undo, see tools/README.md (original values: tools/state/$SERIAL.env)."
