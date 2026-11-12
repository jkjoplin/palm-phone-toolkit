#!/usr/bin/env node
/* Lint the page for what the phone cannot do (Chrome 101 WebView on an Adreno 505, page loaded from
   file:///android_asset/). Checks ui/index.html, ui/*.css and ui/*.js (not dev/, which runs in node).
   usage: node ui/dev/lint.js            exit 1 on any finding */
'use strict';
const fs = require('fs');
const path = require('path');
const UI = path.join(__dirname, '..');

const files = fs.readdirSync(UI).filter((f) => /\.(html|css|js)$/.test(f)).map((f) => path.join(UI, f));
if (fs.existsSync(path.join(UI, '_bridge'))) console.log('FINDING ui/_bridge/ exists: the shell owns that path (debug bridge page)');

// [regex, what, applies-to]
const RULES = [
  [/:has\(/, ':has() (Chrome 105)', 'css'],
  [/@container|container-type/, 'container queries (Chrome 105)', 'css'],
  [/color-mix\(/, 'color-mix() (Chrome 111)', 'css'],
  [/\b\d*\.?\d+(dvh|svh|lvh|dvw|svw|lvw)\b/, 'dynamic viewport units (Chrome 108)', 'css'],
  [/\b100vh\b/, '100vh (lies on Android: size from innerHeight via --u)', 'css'],
  [/view-transition|startViewTransition/, 'view transitions (Chrome 111)', 'any'],
  [/text-wrap\s*:/, 'text-wrap (Chrome 114)', 'css'],
  [/backdrop-filter/, 'backdrop-filter (too slow on the Adreno 505)', 'css'],
  [/\blinear\(/, 'linear() easing (Chrome 113)', 'css'],
  [/@layer\b/, 'cascade layers (Chrome 99 is fine, but avoid: untested on the WebView)', 'css'],
  [/<canvas|getContext\(|WebGL/i, 'canvas / WebGL', 'any'],
  [/type\s*=\s*["']module["']/, 'ES modules (blocked on file://)', 'html'],
  [/^\s*(import|export)\s/m, 'import/export statements (classic scripts only)', 'js'],
  [/\bfetch\s*\(|XMLHttpRequest/, 'fetch/XHR (blocked for local files; no network content)', 'js'],
  [/<iframe/i, 'iframes (window.Shell and the token are visible to every frame)', 'any'],
  [/\.toSorted\(|\.toReversed\(|\.toSpliced\(|\.with\(|Object\.groupBy|Map\.groupBy|Promise\.withResolvers|\.findLastIndex\(|structuredClone/, 'post-101 JS built-ins', 'js'],
  [/https?:\/\/(?!www\.w3\.org)/, 'a remote URL (no network at runtime)', 'any'],
  [/console\.(log|info|debug)\s*\(/, 'console logging (goes to logcat; never log config or token)', 'js']
];

let findings = 0;
function report(file, line, what, text) { findings++; console.log('FINDING ' + path.relative(UI, file) + ':' + line + '  ' + what + '\n    ' + text.trim().slice(0, 140)); }

files.forEach((file) => {
  const ext = path.extname(file).slice(1);
  let text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  RULES.forEach(([re, what, kind]) => {
    if (kind !== 'any' && kind !== ext && !(kind === 'css' && ext === 'html') && !(kind === 'js' && ext === 'html' && false)) return;
    lines.forEach((l, i) => { if (re.test(l)) report(file, i + 1, what, l); });
  });
  if (ext === 'css' || ext === 'html') {
    // CSS nesting: a selector block opened inside another block
    let depth = 0, inAt = [];
    const css = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    if (ext === 'css') {
      for (let i = 0, ln = 1; i < css.length; i++) {
        const c = css[i];
        if (c === '\n') ln++;
        if (c === '{') {
          const before = css.slice(css.lastIndexOf('}', i) + 1, i);
          const isAt = /@(media|supports|keyframes|font-face)/.test(before) || /^\s*(\d+%|from|to)(\s*,\s*\d+%)*\s*$/.test(before.split(/[;{]/).pop());
          if (depth > 0 && !inAt[depth - 1]) report(file, ln, 'CSS nesting (Chrome 112)', before);
          inAt[depth] = /@(media|supports|keyframes)/.test(before);
          depth++;
        } else if (c === '}') depth--;
      }
    }
    // animations and transitions: transform and opacity only
    // (plus the hold ring's stroke-dashoffset and discrete visibility, as in the reviewed mockup)
    const ALLOWED = /^(transform|opacity|stroke-dashoffset|visibility|none)$/;
    lines.forEach((l, i) => {
      const m = /(?:^|[;{\s])transition\s*:\s*([^;}]+)/.exec(l);
      if (m && !/!important/.test(m[1])) {
        m[1].split(',').forEach((part) => {
          const prop = part.trim().split(/\s+/)[0];
          if (!ALLOWED.test(prop)) report(file, i + 1, 'transition on "' + prop + '" (animate only transform and opacity)', l);
        });
      }
      const k = /transition-property\s*:\s*([^;}]+)/.exec(l);
      if (k) k[1].split(',').forEach((p) => { if (!ALLOWED.test(p.trim())) report(file, i + 1, 'transition-property ' + p.trim(), l); });
    });
    const kf = css.match(/@keyframes[^{]+\{([^{}]*\{[^{}]*\})*[^{}]*\}/g) || [];
    kf.forEach((block) => {
      const props = block.match(/[{;]\s*([a-z-]+)\s*:/g) || [];
      props.forEach((p) => { const name = p.replace(/[{;:\s]/g, ''); if (!/^(transform|opacity)$/.test(name)) report(file, 0, 'keyframes animate "' + name + '"', block.slice(0, 60)); });
    });
    if (/animation[^;]*filter|transition[^;]*filter/.test(css)) report(file, 0, 'animated filter', '');
  }
  if (ext === 'js') {
    // style writes from JS that would animate something other than transform/opacity
    lines.forEach((l, i) => { if (/style\.transition\s*=\s*['"](?!none|transform)/.test(l)) report(file, i + 1, 'JS transition on a non-transform property', l); });
  }
});

// every glyph key used by the HA package must exist in glyphs.js
try {
  const { loadMoods } = require('./mood-yaml');
  const moods = loadMoods(path.join(UI, '..', 'ha', 'packages', 'moods'));
  global.window = {};
  new Function('window', fs.readFileSync(path.join(UI, 'glyphs.js'), 'utf8'))(global.window);
  const keys = global.window.Glyphs.keys;
  moods.forEach((m) => { const g = m.attributes.mood_glyph; if (keys.indexOf(g) < 0) report(path.join(UI, 'glyphs.js'), 0, 'no glyph for key "' + g + '" used by ' + m.file, ''); });
  console.log('glyph keys used by ha/packages/moods: ' + Array.from(new Set(moods.map((m) => m.attributes.mood_glyph))).join(', ') + ' -> all present: ' + moods.every((m) => keys.indexOf(m.attributes.mood_glyph) >= 0));
} catch (e) { console.log('glyph check skipped: ' + e.message); }

// the approved mockup palettes (ember.html) must pass through Moods.palette() unchanged: accent, ink
// and every sky layer, both as mock.js carries them and as the package files do. And mock.js's five
// demo moods must carry exactly the package's attributes, so the demo never drifts from the house.
try {
  const win = {};
  new Function('window', fs.readFileSync(path.join(UI, 'moods.js'), 'utf8'))(win);
  win.MockHA = null;
  const mockWin = {};
  new Function('window', 'setTimeout', fs.readFileSync(path.join(UI, 'mock.js'), 'utf8'))(mockWin, setTimeout);
  const APPROVED = {   // the approved Ember mockup's MOODS (the mockup itself is not included): accent, ink, and sky as [kind, r, g, b, alpha, w, h, x, y, drift]
    wind_down: ['#f2a65e', '#f8e8d4', [['band', 128, 52, 30, .38, 640, 300, 50, 30, 2], ['lamp', 214, 116, 44, .54, 640, 520, 50, 96, 1], ['glow', 96, 70, 112, .14, 380, 380, 94, 2, 3]]],
    movie_night: ['#e8574c', '#f6e0da', [['band', 88, 10, 22, .5, 640, 320, 50, 36, 2], ['lamp', 168, 22, 24, .62, 580, 480, 50, 100, 1], ['glow', 46, 70, 132, .26, 360, 360, 4, 4, 3]]],
    afterglow: ['#f4917c', '#f8e4ec', [['band', 92, 50, 164, .46, 640, 320, 50, 20, 2], ['lamp', 186, 56, 122, .54, 620, 500, 50, 99, 1], ['glow', 230, 112, 66, .26, 300, 300, 96, 72, 3]]],
    lights_out: ['#a9b6e6', '#dfe3f2', [['band', 36, 44, 100, .56, 640, 380, 50, 22, 2], ['glow', 20, 48, 68, .4, 480, 480, 96, 64, 3], ['lamp', 176, 92, 40, .24, 320, 240, 50, 103, 1]]],
    good_morning: ['#f6c27c', '#fcf0e2', [['band', 84, 110, 150, .4, 640, 300, 50, 10, 2], ['lamp', 234, 152, 64, .5, 660, 520, 50, 98, 1], ['glow', 240, 190, 140, .12, 320, 320, 6, 54, 3]]]
  };
  const M = win.Moods, demo = mockWin.MockHA.moods();
  const pkg = require('./mood-yaml').loadMoods(path.join(UI, '..', 'ha', 'packages', 'moods'));
  [['mock.js', demo], ['ha/packages/moods', pkg]].forEach(([where, list]) => {
    Object.keys(APPROVED).forEach((slug) => {
      const d = list.find((x) => x.entity_id === 'script.mood_' + slug);
      if (!d) { report(where, 0, 'mood ' + slug + ' missing', ''); return; }
      const [acc, ink, layers] = APPROVED[slug];
      const pal = M.palette(d.attributes.mood_palette);
      if (M.toHex(pal.accent) !== acc) report(where, 0, slug + ': accent ' + acc + ' became ' + M.toHex(pal.accent), '');
      if (M.toHex(pal.ink) !== ink) report(where, 0, slug + ': ink ' + ink + ' became ' + M.toHex(pal.ink), '');
      const got = JSON.stringify((M.sky(pal, slug, false, 0) || []).map((g) => [g[0]].concat(g[1].map(Math.round), [Math.round(g[2] * 1000) / 1000], g.slice(3))));
      if (got !== JSON.stringify(layers)) report(where, 0, slug + ': sky changed', got);
    });
  });
  // every other package mood with a hand-tuned sky must also come through unclamped (a clamp means
  // what renders is not what was tuned)
  pkg.filter((m) => !APPROVED[m.entity_id.replace(/^script\.mood_/, '')] && m.attributes.mood_palette && m.attributes.mood_palette.sky).forEach((m) => {
    const want = JSON.stringify(m.attributes.mood_palette.sky.map((g) => [g[0], String(g[1]).toLowerCase()].concat(g.slice(2))));
    const got = JSON.stringify((M.palette(m.attributes.mood_palette).layers || []).map((g) => [g[0], M.toHex(g[1])].concat([Math.round(g[2] * 1000) / 1000], g.slice(3))));
    if (got !== want) report(m.file, 0, m.entity_id + ': sky is clamped or dropped by the UI', got);
  });
  demo.forEach((d) => {
    const p = pkg.find((x) => x.entity_id === d.entity_id);
    if (!p) { report(path.join(UI, 'mock.js'), 0, d.entity_id + ' is not in the package', ''); return; }
    const keys = Array.from(new Set(Object.keys(d.attributes).concat(Object.keys(p.attributes)))).filter((k) => k !== 'icon');
    keys.forEach((k) => { if (JSON.stringify(d.attributes[k]) !== JSON.stringify(p.attributes[k])) report(path.join(UI, 'mock.js'), 0, d.entity_id + ' ' + k + ' differs from ' + p.file, JSON.stringify(d.attributes[k]) + ' vs ' + JSON.stringify(p.attributes[k])); });
  });
  // the approved card text (the moods ship without music, and the guest room night light stays
  // opt-in and off, so no card promises either), for every package mood and the five in mock.js.
  // A new mood is added here with its approved text.
  const APPROVED_TEXT = {
    wind_down: ['Lamps low and warm. Diffuser on. Settle in.', 'Diffuser on'],
    movie_night: ['TV on. One lamp, deep red. Everything else off.', 'TV on'],
    afterglow: ['Loft and patio washed in colour. Stay a while.', 'Loft lights on'],
    lights_out: ['Lamps out, TV off. Bed cools. Sleep well.', 'Bed cooling'],
    good_morning: ['Lamps rise to daylight. The loft wakes too.', 'Lamps rising'],
    focus: ['Office bright and cool. Nothing else changes.', 'Office lit'],
    hosting: ['Patio and porch glowing. Come on in.', 'Patio lit'],
    away: ['Everything off. Heating to eco.', 'House resting'],
    showcase: ['The office lamp, a new colour every time.', 'Lamp glowing']
  };
  // nothing on a card may promise music (no mood has any configured) or the guest room (opt-in, off).
  // When music ships, change this rule and APPROVED_TEXT together.
  const UNPROMISED = /music|beats|radio|song|playlist|speaker|guest.?room/i;
  // the approved time windows (mood_window); every other mood has none (Afterglow included)
  const APPROVED_WINDOWS = { good_morning: { from: '05:00', to: '11:00' } };
  const HouseSim = require('../sim.js');
  [['mock.js', demo], ['ha/packages/moods', pkg]].forEach(([where, list]) => {
    list.forEach((d) => {
      const slug = d.entity_id.replace(/^script\.mood_/, ''), a = d.attributes, want = APPROVED_TEXT[slug];
      if (!want) { report(where, 0, slug + ': no approved card text in lint.js APPROVED_TEXT', ''); return; }
      if (a.mood_tagline !== want[0]) report(where, 0, slug + ': mood_tagline is not the approved text', JSON.stringify(a.mood_tagline) + ' vs ' + JSON.stringify(want[0]));
      if (a.mood_status !== want[1]) report(where, 0, slug + ': mood_status is not the approved text', JSON.stringify(a.mood_status) + ' vs ' + JSON.stringify(want[1]));
      ['mood_name', 'mood_tagline', 'mood_status', 'mood_scope'].forEach((k) => { if (UNPROMISED.test(String(a[k] || ''))) report(where, 0, slug + ': ' + k + ' promises music or the guest room', String(a[k])); });
      if (HouseSim.windowState(a.mood_window).state === 'bad') report(where, 0, slug + ': malformed mood_window (want { from: "HH:MM", to: "HH:MM" }, two different quoted times)', JSON.stringify(a.mood_window));
      if (JSON.stringify(a.mood_window == null ? null : a.mood_window) !== JSON.stringify(APPROVED_WINDOWS[slug] || null)) report(where, 0, slug + ': mood_window is not the approved one', JSON.stringify(a.mood_window) + ' vs ' + JSON.stringify(APPROVED_WINDOWS[slug] || null));
    });
  });
  console.log('approved mockup accents, inks and skies pass through palette()/sky() unchanged (mock.js and package): ' + Object.keys(APPROVED).join(', '));
  console.log('approved card text, no music or guest room promises, approved time windows (' + Object.keys(APPROVED_WINDOWS).map((k) => k + ' ' + APPROVED_WINDOWS[k].from + '-' + APPROVED_WINDOWS[k].to).join(', ') + '): all ' + pkg.length + ' package moods and ' + demo.length + ' demo moods');
  console.log('mock.js demo moods match the package attribute for attribute: ' + demo.map((d) => d.entity_id.replace(/^script\.mood_/, '')).join(', '));
} catch (e) { report(path.join(UI, 'moods.js'), 0, 'palette check failed: ' + e.message, ''); }

// the settings on the Home Assistant "Moods" dashboard (moods_settings.yaml). Each mood reads its own
// input_select.moods_<slug>_<suffix> as a list of whole numbers, all or nothing: one
// `ok: "{{ look | count == N and LO <= look[0] <= HI and ... }}"` line covers the count and every range, and
// each value is `look[i] if ok else D`. The tokenizer (signed and decimal numbers count, and then reject the
// whole option) must be the one below. The first option must be "Usual (...)" with exactly the mood's
// fallbacks D, so a fresh helper is today's behaviour, and every option must give N numbers inside the
// mood's ranges, so no option is silently ignored. The phones' two settings per panel must be options the
// UI understands.
try {
  const { loadHelpers } = require('./mood-yaml');
  const PKG = path.join(UI, '..', 'ha', 'packages', 'moods');
  const helpers = loadHelpers(PKG);
  const used = {};
  // as the moods read an option: tokens -?[0-9]+(?:[.][0-9]+)?, all plain digits or none are used
  const nums = (s) => { const t = String(s).match(/-?[0-9]+(?:[.][0-9]+)?/g) || []; return t.every((x) => /^[0-9]+$/.test(x)) ? t.map(Number) : null; };
  const TOKENIZER = "{% set t = states('input_select.moods_' ~ this.entity_id | replace('script.mood_', '') ~ '_SUF')\n                    | regex_findall('-?[0-9]+(?:[.][0-9]+)?') %}\n            {{ t | map('int') | list if t | select('match', '^[0-9]+$') | list | count == t | count else [] }}";
  fs.readdirSync(PKG).filter((f) => /\.ya?ml$/.test(f)).forEach((f) => {
    const text = fs.readFileSync(path.join(PKG, f), 'utf8');
    const slugM = /^ {2}mood_([a-z0-9_]+):\s*$/m.exec(text);
    const rd = /input_select\.moods_' ~ this\.entity_id \| replace\('script\.mood_', ''\) ~ '_([a-z0-9_]+)'\)/.exec(text);
    if (!rd) return;
    if (!slugM) { report(path.join(PKG, f), 0, 'reads a setting but has no mood script', ''); return; }
    const id = 'input_select.moods_' + slugM[1] + '_' + rd[1];
    used[id] = true;
    if (text.indexOf(TOKENIZER.replace('SUF', rd[1])) < 0) report(path.join(PKG, f), 0, 'setting reader does not use the shared all-or-nothing tokenizer', '');
    const okM = /^ {10}ok: "\{\{ look \| count == (\d+)((?: and -?\d+ <= look\[\d+\] <= -?\d+)+) \}\}"$/m.exec(text);
    if (!okM) { report(path.join(PKG, f), 0, 'reads ' + id + ' but has no `ok:` line of the checked form', ''); return; }
    const rng = {};
    okM[2].replace(/ and (-?\d+) <= look\[(\d+)\] <= (-?\d+)/g, (_, lo, i, hi) => { if (rng[i]) report(path.join(PKG, f), 0, id + ': look[' + i + '] is range-checked twice', ''); rng[i] = { lo: +lo, hi: +hi }; return ''; });
    const vals = [];
    const re = /look\[(\d+)\] if (\w+) else (-?\d+)/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[2] !== 'ok') { report(path.join(PKG, f), 0, 'setting value not guarded by the one `ok`', m[0]); continue; }
      if (!rng[m[1]]) { report(path.join(PKG, f), 0, 'setting reader uses look[' + m[1] + '] but `ok` does not range-check it', m[0]); continue; }
      vals.push({ i: +m[1], n: +okM[1], lo: rng[m[1]].lo, hi: rng[m[1]].hi, d: +m[3] });
    }
    if (/look\[\d+\] if look \|/.test(text)) report(path.join(PKG, f), 0, 'setting value checked on its own instead of with `ok` (all or nothing)', '');
    Object.keys(rng).forEach((i) => { if (!vals.some((x) => x.i === +i)) report(path.join(PKG, f), 0, id + ': `ok` checks look[' + i + '] but no value uses it', ''); if (+i >= +okM[1]) report(path.join(PKG, f), 0, id + ': `ok` checks look[' + i + '] beyond the count ' + okM[1], ''); });
    if (Object.keys(rng).length !== +okM[1]) report(path.join(PKG, f), 0, id + ': `ok` must range-check each of the ' + okM[1] + ' numbers', '');
    if (!vals.length) { report(path.join(PKG, f), 0, 'reads ' + id + ' but no value line has the checked form', ''); return; }
    const n = vals[0].n;
    vals.forEach((x) => { if (x.n !== n) report(path.join(PKG, f), 0, id + ': readers disagree on the count of numbers', ''); if (!(x.lo <= x.d && x.d <= x.hi)) report(path.join(PKG, f), 0, id + ': fallback ' + x.d + ' is outside ' + x.lo + '..' + x.hi, ''); });
    const h = helpers[id];
    if (!h) { report(path.join(PKG, f), 0, 'reads ' + id + ', which moods_settings.yaml does not define', ''); return; }
    const opts = h.options || [];
    if (!opts.length || opts.some((o) => typeof o !== 'string')) report(path.join(PKG, h.file), 0, id + ': every option must be a quoted string', JSON.stringify(opts));
    if (!/^Usual \(/.test(String(opts[0]))) report(path.join(PKG, h.file), 0, id + ': the first option must be "Usual (...)" (today\'s behaviour)', String(opts[0]));
    const want = vals.slice().sort((a, b) => a.i - b.i).map((x) => x.d);
    if (JSON.stringify(nums(opts[0])) !== JSON.stringify(want)) report(path.join(PKG, h.file), 0, id + ': first option ' + JSON.stringify(opts[0]) + ' is not the mood\'s built-in values ' + JSON.stringify(want), '');
    if (new Set(opts).size !== opts.length) report(path.join(PKG, h.file), 0, id + ': duplicate options', '');
    opts.forEach((o) => {
      const v = nums(o);
      if (!v) report(path.join(PKG, h.file), 0, id + ': option ' + JSON.stringify(o) + ' has a signed or decimal number (it would be ignored)', '');
      else if (v.length !== n) report(path.join(PKG, h.file), 0, id + ': option ' + JSON.stringify(o) + ' has ' + v.length + ' numbers, the mood reads ' + n + ' (it would be ignored)', '');
      else vals.forEach((x) => { if (!(x.lo <= v[x.i] && v[x.i] <= x.hi)) report(path.join(PKG, h.file), 0, id + ': option ' + JSON.stringify(o) + ' number ' + v[x.i] + ' is outside the mood\'s ' + x.lo + '..' + x.hi + ' (it would be ignored)', ''); });
    });
  });
  const NIGHT_RE = /^([01]\d|2[0-3]):([0-5]\d) to ([01]\d|2[0-3]):([0-5]\d)$/;   // as ui/app.js reads it
  Object.keys(helpers).forEach((id) => {
    const h = helpers[id], opts = (h.options || []).map(String);
    if (/^input_select\.moods_panel_[a-z0-9_]+_night_hours$/.test(id)) {
      if (NIGHT_RE.test(opts[0]) || /^no night hours$/i.test(opts[0])) report(path.join(PKG, h.file), 0, id + ': the first option must be the phone\'s own hours (one the UI does not read)', opts[0]);
      opts.slice(1).forEach((o) => { if (!NIGHT_RE.test(o) && !/^no night hours$/i.test(o)) report(path.join(PKG, h.file), 0, id + ': the phones do not understand option ' + JSON.stringify(o), ''); });
    } else if (/^input_select\.moods_panel_[a-z0-9_]+_screen$/.test(id)) {
      if (opts[0] !== 'Usual (100%)') report(path.join(PKG, h.file), 0, id + ': the first option must be "Usual (100%)"', opts[0]);
      opts.forEach((o) => { const v = nums(o); if (!v || v.length !== 1 || v[0] < 50 || v[0] > 150) report(path.join(PKG, h.file), 0, id + ': the phones ignore option ' + JSON.stringify(o) + ' (one number, 50 to 150)', ''); });
    } else if (/^input_select\.moods_/.test(id) && !used[id]) report(path.join(PKG, h.file), 0, id + ' is not read by any mood', '');
  });
  console.log('settings: ' + Object.keys(used).length + ' mood settings start at their mood\'s built-in values and stay in range; ' + Object.keys(helpers).filter((k) => /moods_panel_/.test(k)).length + ' panel settings readable by the phones');
} catch (e) { report(path.join(UI, 'dev', 'lint.js'), 0, 'settings check failed: ' + e.message, ''); }

console.log(findings ? findings + ' finding(s)' : 'clean: ' + files.map((f) => path.basename(f)).join(', '));
process.exit(findings ? 1 : 0);
