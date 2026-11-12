#!/bin/zsh
# usage: shot.sh <name> "<params>" [w h] [budget_ms] [out_dir]
# Renders http://127.0.0.1:8766/index.html?<params> in an exact WxH iframe (default 360x640, DPR 2)
# and writes <out_dir>/ui-<name>.png (default out_dir: ui/dev/shots, which is git-ignored).
# Plain --window-size does NOT give an exact viewport, hence the iframe.
# Headless virtual time may not advance the page's setTimeouts inside the iframe, so use this for
# static=1 stills only; for anything timed (applied, marks, reconnect) use cdp.js / shots.js / drive.js.
N=$1; P=$2; W=${3:-360}; H=${4:-640}; B=${5:-5000}
OUTD=${6:-${0:A:h}/shots}
WD=$(mktemp -d -t pm-ui-wrap); mkdir -p $OUTD
WW=700; WH=$((H+460)); L=$(((WW-W)/2)); T=230
WR=$WD/wrap-$N.html
print -r -- "<!doctype html><html><body style=\"margin:0;background:#000;overflow:hidden\"><iframe src=\"http://127.0.0.1:8766/index.html?$P\" style=\"border:0;position:absolute;left:${L}px;top:${T}px;width:${W}px;height:${H}px\"></iframe></body></html>" > $WR
OUT=$OUTD/ui-$N.png
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars --disable-gpu --user-data-dir=$WD/chrome --force-device-scale-factor=2 --window-size=$WW,$WH --virtual-time-budget=$B --screenshot=$OUT "file://$WR" >/dev/null 2>&1
# the iframe sits at the centre of the wrapper window, so a centred crop cuts it out exactly (DPR 2)
sips -c $((H*2)) $((W*2)) $OUT >/dev/null 2>&1
rm -rf $WD
echo "wrote $OUT"
