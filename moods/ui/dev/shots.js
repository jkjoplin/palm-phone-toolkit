#!/usr/bin/env node
/* Render the UI's reference screenshots in exact viewports over DevTools.
   usage: node ui/dev/shots.js [base_url] [out_dir] [filter]
     base_url  default http://127.0.0.1:8766/index.html
     out_dir   default ui/dev/shots (git-ignored), files are named ui-<name>.png
     filter    only shots whose name contains this
   Extra query parameters for every shot can be given in SHOT_EXTRA (e.g. "ha=ws://127.0.0.1:8767/api/websocket&token=test-token").
   Against a Home Assistant (SHOT_EXTRA with ha=), state=applied does not change the house, so the
   applied shots open the deck and do a real 0.8 s hold instead (the fake HA's house changes). */
'use strict';
const path = require('path');
const { launch, sleep } = require('./cdp');

const base = process.argv[2] || 'http://127.0.0.1:8766/index.html';
const out = process.argv[3] || path.join(__dirname, 'shots');
const filter = process.argv[4] || '';
const extra = process.env.SHOT_EXTRA || 'mock=1';
const prefix = process.env.SHOT_PREFIX || 'ui';

// name, params, wait ms, w, h
const SHOTS = [
  ['idle', 'time=21:18&static=1', 2500, 360, 640],
  ['deck', 'time=21:18&state=deck&mood=1&static=1', 2500, 360, 640],
  ['applied', 'time=21:18&state=applied&mood=2&static=1', 9500, 360, 640],
  ['night', 'time=21:19&night=1&static=1', 2500, 360, 640],
  ['nightdeck', 'time=02:10&state=deck&mood=0&static=1', 2500, 360, 640],
  ['idle424', 'time=21:18&static=1', 2500, 424, 753],
  ['deck424', 'time=21:18&state=deck&mood=1&static=1', 2500, 424, 753],
  ['applied424', 'time=21:18&state=applied&mood=2&static=1', 9500, 424, 753],
  ['night424', 'time=21:19&night=1&static=1', 2500, 424, 753],
  ['focus-many', 'time=15:40&state=deck&mood=5&mockset=many&static=1', 2500, 360, 640],
  ['broken-many', 'time=15:40&state=deck&mood=11&mockset=many&static=1', 2500, 360, 640],
  ['bright-many', 'time=15:40&state=deck&mood=9&mockset=many&static=1', 2500, 360, 640]
];

(async () => {
  const b = await launch();
  try {
    for (const [name, params, wait, w, h] of SHOTS) {
      if (filter && name.indexOf(filter) < 0) continue;
      const p = await b.page(w, h);
      const live = /(^|&)ha=/.test(extra) && /state=applied/.test(params);
      const url = base + '?' + [extra, live ? params.replace('state=applied', 'state=deck') : params].filter(Boolean).join('&');
      await p.go(url, live ? 2500 : wait);
      if (live) {
        const u = Math.min(w / 360, h / 640);
        await p.press(w / 2, 485 * u, 800);
        await sleep(wait - 2500);
      }
      const file = path.join(out, prefix + '-' + name + '.png');
      await p.shot(file);
      const info = await p.eval('window.__moods ? JSON.stringify(window.__moods.info()) : "no __moods"');
      console.log(file + '\n  ' + info + (p.console.length ? '\n  console: ' + p.console.join(' | ') : ''));
      p.close();
      await sleep(100);
    }
  } finally { await b.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
