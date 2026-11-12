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
function report(file, line, what, text) { findings++; console.log('FINDING ' + path.relative(UI, file) + ':' + line + '  ' + what + '\n    ' + String(text == null ? '' : text).trim().slice(0, 140)); }

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
// The last option of each mood setting is exactly "Custom (sliders below)": then the tokens are the states
// of input_number.moods_<slug>_<suffix>_1.._N (a trailing .0 dropped), each slider's min and max exactly
// look[i-1]'s range, put at the Usual value D once by script.moods_sliders_usual. Exactly the seven known
// settings must be found (a reader that stops matching cannot let this check go silently dead). The ranges
// are pinned in APPROVED (widening one is a review, not a two-number edit), the moods read nothing else
// called input_select.moods_* / input_number.moods_*, and the automations in moods_settings.yaml must be
// exactly the text built here from the sliders (comments aside).
try {
  const { loadHelpers, readSection } = require('./mood-yaml');
  const PKG = path.join(UI, '..', 'ha', 'packages', 'moods');
  const helpers = loadHelpers(PKG);
  const used = {};
  // as the moods read an option: tokens -?[0-9]+(?:[.][0-9]+)?, all plain digits or none are used
  const nums = (s) => { const t = String(s).match(/-?[0-9]+(?:[.][0-9]+)?/g) || []; return t.every((x) => /^[0-9]+$/.test(x)) ? t.map(Number) : null; };
  const CUSTOM = 'Custom (sliders below)';
  const SETTINGS = ['wind_down_look', 'movie_night_look', 'afterglow_look', 'lights_out_bed', 'good_morning_look', 'focus_look', 'hosting_look'].map((x) => 'input_select.moods_' + x);
  // the approved range and unit of each number of each setting (ha/README.md's table)
  const APPROVED = {
    'input_select.moods_wind_down_look': [[10, 50, '%'], [2000, 3000, 'K']],
    'input_select.moods_movie_night_look': [[1, 20, '%']],
    'input_select.moods_afterglow_look': [[10, 80, '%'], [10, 100, '%']],
    'input_select.moods_lights_out_bed': [[62, 70, '°F']],
    'input_select.moods_good_morning_look': [[30, 70, '%'], [10, 80, '%']],
    'input_select.moods_focus_look': [[50, 100, '%'], [4000, 6500, 'K']],
    'input_select.moods_hosting_look': [[20, 100, '%'], [20, 100, '%']]
  };
  const SEEDED = 'input_boolean.moods_sliders_seeded';
  // the reader, for a setting with suffix SUF and N numbers
  const TOKENIZER = (suf, n) => "{% set o = states('input_select.moods_' ~ this.entity_id | replace('script.mood_', '') ~ '_" + suf + "') %}\n" +
    "            {% set p = 'input_number.moods_' ~ this.entity_id | replace('script.mood_', '') ~ '_" + suf + "_' %}\n" +
    "            {% if o == '" + CUSTOM + "' and is_state('" + SEEDED + "', 'on') %}{% set t = [" + Array.from({ length: n }, (_, i) => 'states(p ~ ' + (i + 1) + ')').join(', ') + "] | map('regex_replace', '[.]0$', '') | list %}\n" +
    "            {% else %}{% set t = o | regex_findall('-?[0-9]+(?:[.][0-9]+)?') %}{% endif %}\n" +
    "            {{ t | map('int') | list if t | select('match', '^[0-9]+$') | list | count == t | count else [] }}";
  const numbers = {}, numberFile = {};
  fs.readdirSync(PKG).filter((f) => /\.ya?ml$/.test(f)).forEach((f) => { const sec = readSection(fs.readFileSync(path.join(PKG, f), 'utf8'), 'input_number'); Object.keys(sec).forEach((k) => { if (numbers[k]) report(path.join(PKG, f), 0, 'input_number.' + k + ' is defined twice', ''); numbers[k] = sec[k]; numberFile[k] = f; }); });
  const sliders = {};   // input_number object id -> true, for every slider a reader uses
  const usualOf = {};   // input_select id -> the Usual values, in order
  const settingsText = fs.readFileSync(path.join(PKG, 'moods_settings.yaml'), 'utf8');
  // what script.moods_sliders_usual sets: object id -> [values]
  const seedSec = (settingsText.split(/\n(?=  [a-z])/).find((x) => /^ {2}moods_sliders_usual:/.test(x)) || '');
  const seeds = {};
  seedSec.replace(/- action: input_number\.set_value\n {8}target:\n {10}entity_id: input_number\.([a-z0-9_]+)\n {8}data:\n {10}value: (-?[0-9.]+)\n/g, (_, e, v) => { (seeds[e] = seeds[e] || []).push(+v); return ''; });
  fs.readdirSync(PKG).filter((f) => /\.ya?ml$/.test(f)).forEach((f) => {
    const text = fs.readFileSync(path.join(PKG, f), 'utf8');
    const slugM = /^ {2}mood_([a-z0-9_]+):\s*$/m.exec(text);
    const rd = /input_select\.moods_' ~ this\.entity_id \| replace\('script\.mood_', ''\) ~ '_([a-z0-9_]+)'\)/.exec(text);
    if (!rd) { if (/(input_select|input_number)\.moods_'/.test(text)) report(path.join(PKG, f), 0, 'reads a moods_ setting in a form lint.js does not recognise', ''); return; }
    if (!slugM) { report(path.join(PKG, f), 0, 'reads a setting but has no mood script', ''); return; }
    const id = 'input_select.moods_' + slugM[1] + '_' + rd[1];
    used[id] = true;
    const okM = /^ {10}ok: "\{\{ look \| count == (\d+)((?: and -?\d+ <= look\[\d+\] <= -?\d+)+) \}\}"$/m.exec(text);
    if (!okM) { report(path.join(PKG, f), 0, 'reads ' + id + ' but has no `ok:` line of the checked form', ''); return; }
    if (text.indexOf(TOKENIZER(rd[1], +okM[1])) < 0) report(path.join(PKG, f), 0, 'setting reader does not use the shared all-or-nothing tokenizer (with one slider per number)', '');
    // every mention in any form (a literal id would bypass Custom and `ok`): only the reader's own two
    if (text.split('input_select.moods_').length !== 2 || text.split("'input_select.moods_' ~").length !== 2 || text.split('input_number.moods_').length !== 2 || text.split("'input_number.moods_' ~").length !== 2 || text.split(SEEDED).length !== 2) report(path.join(PKG, f), 0, 'a mood reads exactly one setting, in one reader (no other input_select.moods_ / input_number.moods_ / ' + SEEDED + ' anywhere in the file)', '');
    const rng = {};
    okM[2].replace(/ and (-?\d+) <= look\[(\d+)\] <= (-?\d+)/g, (_, lo, i, hi) => { if (rng[i]) report(path.join(PKG, f), 0, id + ': look[' + i + '] is range-checked twice', ''); rng[i] = { lo: +lo, hi: +hi }; return ''; });
    const appr = APPROVED[id];
    if (!appr || appr.length !== +okM[1] || appr.some((a, i) => !rng[i] || rng[i].lo !== a[0] || rng[i].hi !== a[1])) report(path.join(PKG, f), 0, id + ': `ok` ranges must be exactly the approved ' + (appr ? appr.map((a) => a[0] + '..' + a[1]).join(', ') : '(none: not an approved setting)') + ' (APPROVED in lint.js)', okM[0].trim());
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
    const all = h.options || [];
    if (!all.length || all.some((o) => typeof o !== 'string')) report(path.join(PKG, h.file), 0, id + ': every option must be a quoted string', JSON.stringify(all));
    if (all[all.length - 1] !== CUSTOM || all.indexOf(CUSTOM) !== all.length - 1) report(path.join(PKG, h.file), 0, id + ': the last option, and only the last, must be exactly ' + JSON.stringify(CUSTOM), JSON.stringify(all[all.length - 1]));
    const opts = all.filter((o) => o !== CUSTOM);
    // the sliders behind Custom: one per number, min and max exactly that number's range
    const base = 'moods_' + slugM[1] + '_' + rd[1] + '_';
    for (let i = 1; i <= +okM[1]; i++) {
      const k = base + i, x = numbers[k], r = rng[i - 1], v = vals.find((y) => y.i === i - 1);
      if (!x) { report(path.join(PKG, h.file), 0, id + ': no slider input_number.' + k + ' for look[' + (i - 1) + ']', ''); continue; }
      if (numberFile[k] !== 'moods_settings.yaml') report(path.join(PKG, numberFile[k]), 0, 'input_number.' + k + ' belongs in moods_settings.yaml', '');
      if (!r || x.min !== r.lo || x.max !== r.hi) report(path.join(PKG, numberFile[k]), 0, 'input_number.' + k + ': min and max must be exactly the range the mood checks, ' + (r ? r.lo + '..' + r.hi : '?'), x.min + '..' + x.max);
      if (!(Number.isInteger(x.step) && x.step > 0 && r && (r.hi - r.lo) % x.step === 0 && v && (v.d - r.lo) % x.step === 0)) report(path.join(PKG, numberFile[k]), 0, 'input_number.' + k + ': step must be a whole number that reaches both ends and the Usual value', String(x.step));
      if ('initial' in x) report(path.join(PKG, numberFile[k]), 0, 'input_number.' + k + ' must not have initial: (it would reset on every restart)', '');
      if (x.mode !== 'slider') report(path.join(PKG, numberFile[k]), 0, 'input_number.' + k + ' must be mode: slider', String(x.mode));
      if (appr && appr[i - 1] && x.unit_of_measurement !== appr[i - 1][2]) report(path.join(PKG, numberFile[k]), 0, 'input_number.' + k + ': unit_of_measurement must be ' + JSON.stringify(appr[i - 1][2]), String(x.unit_of_measurement));
      if (v && JSON.stringify(seeds[k]) !== JSON.stringify([v.d])) report(path.join(PKG, 'moods_settings.yaml'), 0, 'script.moods_sliders_usual must set input_number.' + k + ' once, to the Usual value ' + v.d, String(JSON.stringify(seeds[k])));
      sliders[k] = true;
    }
    if (numbers[base + (+okM[1] + 1)]) report(path.join(PKG, h.file), 0, id + ': slider input_number.' + base + (+okM[1] + 1) + ' is beyond the ' + okM[1] + ' numbers the mood reads', '');
    if (!/^Usual \(/.test(String(opts[0]))) report(path.join(PKG, h.file), 0, id + ': the first option must be "Usual (...)" (today\'s behaviour)', String(opts[0]));
    const want = vals.slice().sort((a, b) => a.i - b.i).map((x) => x.d);
    usualOf[id] = want;
    if (JSON.stringify(nums(opts[0])) !== JSON.stringify(want)) report(path.join(PKG, h.file), 0, id + ': first option ' + JSON.stringify(opts[0]) + ' is not the mood\'s built-in values ' + JSON.stringify(want), '');
    if (new Set(opts).size !== opts.length) report(path.join(PKG, h.file), 0, id + ': duplicate options', '');
    opts.forEach((o) => {
      const v = nums(o);
      if (!v) report(path.join(PKG, h.file), 0, id + ': option ' + JSON.stringify(o) + ' has a signed or decimal number (it would be ignored)', '');
      else if (v.length !== n) report(path.join(PKG, h.file), 0, id + ': option ' + JSON.stringify(o) + ' has ' + v.length + ' numbers, the mood reads ' + n + ' (it would be ignored)', '');
      else vals.forEach((x) => { if (!(x.lo <= v[x.i] && v[x.i] <= x.hi)) report(path.join(PKG, h.file), 0, id + ': option ' + JSON.stringify(o) + ' number ' + v[x.i] + ' is outside the mood\'s ' + x.lo + '..' + x.hi + ' (it would be ignored)', ''); });
    });
  });
  // the dashboard shows each mood's sliders in one conditional card, only while its setting is Custom
  const DASHF = path.join(UI, '..', 'ha', 'dashboards', 'palm_moods.yaml'), dashText = fs.readFileSync(DASHF, 'utf8');
  Object.keys(used).forEach((id) => {
    const m = new RegExp('\\n {10}- type: conditional\\n {12}conditions:\\n {14}- condition: state\\n {16}entity: ' + id.replace(/\./g, '[.]') + '\\n {16}state: "' + CUSTOM.replace(/[()]/g, '[$&]') + '"\\n {12}card:\\n {14}type: entities\\n {14}show_header_toggle: false\\n {14}entities:\\n((?: {16}- entity: input_number[.][a-z0-9_]+\\n {18}name: .*\\n)+)').exec(dashText);
    const want = Object.keys(sliders).filter((k) => k.indexOf(id.replace(/^input_select\./, '') + '_') === 0).sort();
    const got = m ? (m[1].match(/input_number[.][a-z0-9_]+/g) || []).map((x) => x.replace(/^input_number[.]/, '')).sort() : [];
    if (JSON.stringify(got) !== JSON.stringify(want)) report(DASHF, 0, id + ': the dashboard needs one conditional card (state "' + CUSTOM + '") with exactly its sliders', JSON.stringify(got));
    // the id once in the whole file, in any form (short-form row, quoted, a template): only in its card
    want.forEach((k) => { if ((dashText.match(new RegExp('input_number[.]' + k + '(?![a-z0-9_])', 'g')) || []).length !== 1 || dashText.split('entity: input_number.' + k + '\n').length !== 2) report(DASHF, 0, 'input_number.' + k + ' must appear once on the dashboard, inside its Custom card', ''); });
    // the markdown right after the card gives each slider's range ("<min> to <max><unit>"), in order:
    // an entities slider row shows the value but not its ends
    const md = m && /^ {10}- type: markdown\n {12}text_only: true\n {12}content: [>|]-?\n((?: {14}.*\n)+)/.exec(dashText.slice(m.index + m[0].length));
    const mdText = md ? md[1].replace(/\s+/g, ' ') : '';
    let at = 0;
    want.slice().sort((a, b) => +a.split('_').pop() - +b.split('_').pop()).forEach((k) => {
      const x = numbers[k] || {}, u = String(x.unit_of_measurement), s = x.min + ' to ' + x.max + (u === '%' ? '%' : ' ' + u), j = mdText.indexOf(s, at);
      if (j < 0) report(DASHF, 0, id + ': the markdown after its Custom card must give input_number.' + k + "'s range " + JSON.stringify(s) + ' (after the earlier sliders\' ranges)', mdText.slice(0, 120));
      else at = j + s.length;
    });
  });
  if (JSON.stringify(Object.keys(used).sort()) !== JSON.stringify(SETTINGS.slice().sort())) report(PKG, 0, 'the mood settings found are not exactly the seven known ones (a reader lint.js no longer recognises?)', JSON.stringify(Object.keys(used).sort()));
  Object.keys(numbers).forEach((k) => { if (/^moods_/.test(k) && !/^moods_[a-z0-9_]+_order$/.test(k) && !sliders[k]) report(path.join(PKG, numberFile[k]), 0, 'input_number.' + k + ' is neither an order in the deck nor a slider a mood reads', ''); });
  Object.keys(seeds).forEach((k) => { if (!sliders[k]) report(path.join(PKG, 'moods_settings.yaml'), 0, 'script.moods_sliders_usual sets input_number.' + k + ', which no mood reads', ''); });
  const usualSec = (settingsText.split(/\n(?=  [a-z])/).find((x) => /^ {2}moods_settings_usual:/.test(x)) || '');
  if (usualSec.indexOf('- action: script.moods_sliders_usual\n') < 0) report(path.join(PKG, 'moods_settings.yaml'), 0, 'moods_settings_usual must also put the sliders back (script.moods_sliders_usual)', '');
  // the automations, exactly (comment and blank lines aside): the seed, the nan guard and the save
  const sl = [];   // [entity id, usual], in SETTINGS order
  SETTINGS.forEach((id) => (usualOf[id] || []).forEach((u, i) => sl.push([id.replace(/^input_select[.]/, 'input_number.') + '_' + (i + 1), u])));
  const AUTO = [
    'automation:',
    '  - id: moods_sliders_seed_once',
    '    alias: "Moods: put the Custom sliders at Usual once"',
    '    description: >-',
    "      The first time Home Assistant has all the Custom sliders, sets each to its",
    "      mood's usual value. Never runs again unless",
    '      ' + SEEDED + ' is turned off.',
    '    mode: single',
    '    max_exceeded: silent',
    '    triggers:',
    '      - trigger: homeassistant',
    '        event: start',
    '      - trigger: event',
    '        event_type: automation_reloaded',
    '      - trigger: state',
    '        entity_id: ' + SEEDED,
    '        to: "off"',
    '    conditions:',
    '      - condition: state',
    '        entity_id: ' + SEEDED,
    '        state: "off"',
    '      - condition: template',
    '        value_template: >-',
    '          {{ [' + sl.map((x) => "'" + x[0] + "'").concat(["'script.moods_sliders_usual'"]).join(', ') + ']',
    "             | select('has_value') | list | count == " + (sl.length + 1) + ' }}',
    '    actions:',
    '      - action: script.moods_sliders_usual',
    '      - action: input_boolean.turn_on',
    '        target:',
    '          entity_id: ' + SEEDED,
    '      - action: homeassistant.save_persistent_states',
    '        continue_on_error: true',
    '  - id: moods_sliders_nan_to_usual',
    '    alias: "Moods: put a Custom slider set to nan back at Usual"',
    '    description: >-',
    '      When a Custom slider is set to nan (which input_number.set_value',
    "      accepts), puts every slider of that setting back at its mood's usual",
    "      value at once, so a restart cannot turn it into the slider's minimum.",
    '    mode: queued',
    '    max: 25',
    '    triggers:',
    '      - trigger: state',
    '        entity_id:'
  ].concat(sl.map((x) => '          - ' + x[0]), [
    '        to: "nan"',
    '    actions:',
    '      - variables:',
    '          usual:'
  ], sl.map((x) => '            ' + x[0] + ': ' + x[1]), ['          setting:'], sl.map((x) => '            ' + x[0] + ': [' + sl.filter((y) => y[0].replace(/_[0-9]+$/, '') === x[0].replace(/_[0-9]+$/, '')).map((y) => y[0]).join(', ') + ']'), [
    '      - repeat:',
    '          for_each: "{{ setting[trigger.entity_id] }}"',
    '          sequence:',
    '            - action: input_number.set_value',
    '              target:',
    '                entity_id: "{{ repeat.item }}"',
    '              data:',
    '                value: "{{ usual[repeat.item] }}"',
    '              continue_on_error: true',
    '  - id: moods_settings_save_soon',
    '    alias: "Moods: save the mood settings soon after an edit"',
    '    description: >-',
    '      The mood settings and their Custom sliders are plain helper writes; this',
    '      makes them survive a crash within seconds instead of 15 minutes.',
    '    mode: restart',
    '    triggers:',
    '      - trigger: state',
    '        entity_id:'
  ], [].concat(...SETTINGS.map((id) => ['          - ' + id].concat((usualOf[id] || []).map((_, i) => '          - ' + id.replace(/^input_select[.]/, 'input_number.') + '_' + (i + 1))))), [
    '    conditions:',
    '      - condition: template',
    '        value_template: "{{ trigger.from_state is not none and trigger.from_state.state not in [\'unknown\', \'unavailable\'] }}"',
    '    actions:',
    '      - delay:',
    '          seconds: 10',
    '      - action: homeassistant.save_persistent_states',
    '        continue_on_error: true'
  ]);
  const autoHave = ((settingsText.split(/\n(?=\S)/).find((x) => /^automation:/.test(x)) || '').split('\n').filter((l) => l.trim() && !/^\s*#/.test(l)));
  const autoBad = AUTO.findIndex((l, i) => autoHave[i] !== l);
  if (autoBad >= 0 || autoHave.length !== AUTO.length) { const i = autoBad >= 0 ? autoBad : AUTO.length; report(path.join(PKG, 'moods_settings.yaml'), 0, 'the automations (seed, nan guard, save soon) must be exactly as lint.js builds them; line ' + (i + 1) + ' (comments aside) should be ' + JSON.stringify(AUTO[i] === undefined ? '(the end)' : AUTO[i]), String(autoHave[i] === undefined ? '(the end)' : autoHave[i])); }
  if (/\n {4}initial:/.test((settingsText.split(/\n(?=\S)/).find((x) => /^input_boolean:/.test(x)) || ''))) report(path.join(PKG, 'moods_settings.yaml'), 0, 'input_boolean.moods_sliders_seeded must not have initial: (the seed would run on every start)', '');
  const NIGHT_RE = /^([01]\d|2[0-3]):([0-5]\d) to ([01]\d|2[0-3]):([0-5]\d)$/;   // as ui/app.js reads it
  Object.keys(helpers).forEach((id) => {
    const h = helpers[id], opts = (h.options || []).map(String);
    if (/^input_select\.moods_panel_[a-z0-9_]+_night_hours$/.test(id)) {
      if (NIGHT_RE.test(opts[0]) || /^no night hours$/i.test(opts[0])) report(path.join(PKG, h.file), 0, id + ': the first option must be the phone\'s own hours (one the UI does not read)', opts[0]);
      opts.slice(1).forEach((o) => { if (!NIGHT_RE.test(o) && !/^no night hours$/i.test(o)) report(path.join(PKG, h.file), 0, id + ': the phones do not understand option ' + JSON.stringify(o), ''); });
    } else if (/^input_select\.moods_panel_[a-z0-9_]+_screen$/.test(id)) {
      if (opts[0] !== 'Usual (100%)') report(path.join(PKG, h.file), 0, id + ': the first option must be "Usual (100%)"', opts[0]);
      opts.forEach((o) => { const v = nums(o); if (!v || v.length !== 1 || v[0] < 50 || v[0] > 150) report(path.join(PKG, h.file), 0, id + ': the phones ignore option ' + JSON.stringify(o) + ' (one number, 50 to 150)', ''); });
    } else if (/^input_select\.moods_[a-z0-9_]+_where$/.test(id)) {
      // placement, read by the phones: checked with the custom slots below
    } else if (/^input_select\.moods_/.test(id) && !used[id]) report(path.join(PKG, h.file), 0, id + ' is not read by any mood', '');
  });
  console.log('settings: ' + Object.keys(used).length + ' mood settings start at their mood\'s built-in values and stay in range, ' + Object.keys(sliders).length + ' Custom sliders span exactly their mood\'s ranges and seed to Usual; ' + Object.keys(helpers).filter((k) => /moods_panel_/.test(k)).length + ' panel settings readable by the phones');
} catch (e) { report(path.join(UI, 'dev', 'lint.js'), 0, 'settings check failed: ' + e.message, ''); }

// the custom mood slots (ui/dev/gen-custom.js -> moods_custom.yaml and the dashboard's generated
// subviews) and every mood's placement helpers (moods_<slug>_where / _order)
try {
  const G = require('./gen-custom');
  const { readMoodFile, loadHelpers, readSection } = require('./mood-yaml');
  const PKG = path.join(UI, '..', 'ha', 'packages', 'moods');
  const CUSTOM = path.join(PKG, 'moods_custom.yaml');
  const DASH = path.join(UI, '..', 'ha', 'dashboards', 'palm_moods.yaml');
  const LOCK = path.join(UI, 'dev', 'custom-options.lock.json');
  const T = G.TABLES;
  // 1. the generated files are exactly what the generator writes
  G.check().forEach((m) => report(CUSTOM, 0, m + '  (run node ui/dev/gen-custom.js --write)', ''));
  // the frozen option texts: none renamed, removed or reordered; any new one is in the lock file
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8')), opts = G.options();
  // the built-in moods' settings (input_select.moods_<slug>_look / _bed) are frozen here too, read from the package
  const pkgHelpers = loadHelpers(PKG);
  Object.keys(pkgHelpers).filter((k) => /^input_select\.moods_[a-z0-9_]+_(look|bed)$/.test(k)).forEach((k) => { opts[k] = (pkgHelpers[k].options || []).map(String); });
  Object.keys(opts).forEach((k) => { if (!lock[k]) report(LOCK, 0, 'option list "' + k + '" is not in the lock file', ''); });
  Object.keys(lock).filter((k) => k[0] !== '_').forEach((k) => {
    const have = opts[k] || [];
    let last = -1;
    lock[k].forEach((t) => { const i = have.indexOf(t); if (i < 0) report(LOCK, 0, k + ': frozen option ' + JSON.stringify(t) + ' was renamed or removed (a slot that chose it would silently fall back)', ''); else if (i < last) report(LOCK, 0, k + ': frozen option ' + JSON.stringify(t) + ' moved', ''); last = Math.max(last, i); });
    if (have[0] !== lock[k][0]) report(LOCK, 0, k + ': the first option (the default) changed', JSON.stringify(have[0]));
    have.forEach((t) => { if (lock[k].indexOf(t) < 0) report(LOCK, 0, k + ': option ' + JSON.stringify(t) + ' is not in the lock file (append it there in the same change)', ''); });
  });
  // 2. the tables
  const rolesText = fs.readFileSync(path.join(PKG, 'moods_roles.yaml'), 'utf8');
  const roleIds = new Set();
  // the light groups' names (the multi-line bracketed member lists are beyond mood-yaml.js, so a regex
  // over the light: section): "Role: Bedroom lamps" is light.role_bedroom_lamps
  const lightSec = (rolesText.split(/\n(?=\S)/).find((x) => /^light:/.test(x)) || '');
  (lightSec.match(/^ {4}name: "Role: [^"]+"/gm) || []).forEach((l) => roleIds.add('light.role_' + l.replace(/^ {4}name: "Role: /, '').replace(/"$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')));
  const roleEnts = Object.keys(T.ROLES).map((k) => T.ROLES[k][0]).concat(T.INDOOR);
  roleEnts.forEach((e) => {
    if (!roleIds.has(e)) report(CUSTOM, 0, 'gen-custom.js names ' + e + ', which moods_roles.yaml does not define', '');
    if (/guest_room/.test(e)) report(CUSTOM, 0, 'gen-custom.js names a guest room role: ' + e, '');
    if (e === 'light.role_all_lights') report(CUSTOM, 0, 'gen-custom.js must not offer light.role_all_lights as a step or in INDOOR', '');
  });
  Object.keys(T.ROLES).forEach((k) => { const r = T.ROLES[k]; if (!(Array.isArray(r) && r.length === 4 && typeof r[1] === 'string' && r[1] && typeof r[2] === 'string' && (r[3] === 0 || r[3] === 1))) report(CUSTOM, 0, 'ROLES "' + k + '" is not [entity, touch label, room, 0/1]', JSON.stringify(r)); });
  const pkgText = G.packageYaml();
  const allLines = pkgText.split('\n').filter((l) => l.indexOf('light.role_all_lights') >= 0);
  if (allLines.length !== 1 || allLines[0].indexOf("others_mode == 'all'") < 0) report(CUSTOM, 0, "light.role_all_lights may appear only in the runner's others == 'all' line", allLines.join(' | '));
  if (/guest.?room/i.test(pkgText.replace(/reject\('search', 'guest_room'\)|'guest_room' not in e|never touch(es)? the guest room|never the guest room|touch the guest room|It never touches the guest room|guest room, the thermostat/g, ''))) report(CUSTOM, 0, 'moods_custom.yaml mentions the guest room outside its exclusions', '');
  const gWin = {}; new Function('window', fs.readFileSync(path.join(UI, 'glyphs.js'), 'utf8'))(gWin);
  Object.keys(T.GLYPHS).forEach((k) => { if (gWin.Glyphs.keys.indexOf(T.GLYPHS[k]) < 0) report(CUSTOM, 0, 'GLYPHS "' + k + '" -> ' + T.GLYPHS[k] + ' is not a glyph in glyphs.js', ''); if (!T.GLYPH_ICON[T.GLYPHS[k]]) report(CUSTOM, 0, 'no GLYPH_ICON for ' + T.GLYPHS[k], ''); });
  const mw = {}; new Function('window', fs.readFileSync(path.join(UI, 'moods.js'), 'utf8'))(mw);
  Object.keys(T.PALETTES).forEach((k) => {
    const p = T.PALETTES[k], pal = mw.Moods.palette(p);
    if (p.sky) report(CUSTOM, 0, 'PALETTES "' + k + '" carries a sky (slots never do)', '');
    if (!Array.isArray(p.glows) || p.glows.length !== 3) report(CUSTOM, 0, 'PALETTES "' + k + '" needs three glows', '');
    if (mw.Moods.toHex(pal.accent) !== String(p.accent).toLowerCase()) report(CUSTOM, 0, 'PALETTES "' + k + '": accent ' + p.accent + ' becomes ' + mw.Moods.toHex(pal.accent) + ' in Moods.palette()', '');
    if (p.ink && mw.Moods.toHex(pal.ink) !== String(p.ink).toLowerCase()) report(CUSTOM, 0, 'PALETTES "' + k + '": ink ' + p.ink + ' becomes ' + mw.Moods.toHex(pal.ink) + ' in Moods.palette()', '');
  });
  const HS = require('../sim.js');
  Object.keys(T.WINDOWS).forEach((k) => {
    const w = T.WINDOWS[k], m = /\(([0-9]{2}:[0-9]{2}) to ([0-9]{2}:[0-9]{2})\)$/.exec(k);
    if (!m || m[1] !== w[0] || m[2] !== w[1]) report(CUSTOM, 0, 'WINDOWS "' + k + '": the label does not say its times ' + JSON.stringify(w), '');
    if (HS.windowState({ from: w[0], to: w[1] }).state === 'bad') report(CUSTOM, 0, 'WINDOWS "' + k + '" is not a valid window', '');
  });
  Object.keys(T.BED).forEach((k) => { const v = T.BED[k]; if (!(v === 'off' || (Number.isInteger(v) && v >= 62 && v <= 70))) report(CUSTOM, 0, 'BED "' + k + '" -> ' + v + ' (off, or 62 to 70)', ''); const m = /([0-9]+) °F$/.exec(k); if (m && +m[1] !== v) report(CUSTOM, 0, 'BED "' + k + '" says ' + m[1] + ' but sends ' + v, ''); });
  Object.keys(T.FADE).forEach((k) => { const v = T.FADE[k]; if (!(Number.isInteger(v) && v >= 0 && v <= 60)) report(CUSTOM, 0, 'FADE "' + k + '" -> ' + v + ' (0 to 60 s)', ''); });
  Object.keys(T.DO).forEach((k) => {
    const [kind, arg] = T.DO[k];
    if (kind === 'white') { if (!(Number.isInteger(arg) && arg >= 2000 && arg <= 6500)) report(CUSTOM, 0, 'DO "' + k + '": kelvin ' + arg + ' (2000 to 6500)', ''); const m = /\(([0-9]+) K\)$/.exec(k); if (!m || +m[1] !== arg) report(CUSTOM, 0, 'DO "' + k + '" does not say its kelvin ' + arg, ''); }
    else if (kind === 'colour') { if (!(Array.isArray(arg) && arg.length === 3 && arg.every((v) => Number.isInteger(v) && v >= 0 && v <= 255))) report(CUSTOM, 0, 'DO "' + k + '": rgb ' + JSON.stringify(arg) + ' (three 0 to 255)', ''); }
    else if (kind !== 'keep' && kind !== 'off') report(CUSTOM, 0, 'DO "' + k + '": unknown kind ' + kind, '');
  });
  [T.TV, T.SCENT].forEach((tb) => Object.keys(tb).forEach((k) => { if ([null, 'on', 'off'].indexOf(tb[k]) < 0) report(CUSTOM, 0, 'extra "' + k + '" -> ' + tb[k], ''); }));
  // 3. the card sensors
  const text = fs.readFileSync(CUSTOM, 'utf8');
  const bodyOf = (chunk, key, ind) => { const m = new RegExp('\\n {' + ind + '}' + key + ': \\|-\\n((?: {' + (ind + 2) + '}.*\\n|\\n)+)').exec(chunk); return m ? m[1].replace(new RegExp('^ {' + (ind + 2) + '}', 'gm'), '') : null; };
  for (let n = 1; n <= G.SLOTS; n++) {
    const a = text.indexOf('      - unique_id: moods_custom_' + n + '\n'), b = text.indexOf('\n      - unique_id: ', a + 10);
    if (a < 0) { report(CUSTOM, 0, 'no card sensor with unique_id moods_custom_' + n, ''); continue; }
    const chunk = text.slice(a, b < 0 ? text.indexOf('\nscript:', a) : b) + '\n';
    if (chunk.indexOf('\n        default_entity_id: sensor.moods_custom_' + n + '\n') < 0) report(CUSTOM, 0, 'card sensor ' + n + ': default_entity_id must be sensor.moods_custom_' + n, '');
    const sb = bodyOf(chunk, 'state', 8), cb = bodyOf(chunk, 'card', 10);
    if (!sb || !cb) { report(CUSTOM, 0, 'card sensor ' + n + ': state or attributes.card body not found', ''); continue; }
    const sBody = sb.replace(/\n\{\{- card\.mood_state \}\}\n*$/, ''), cBody = cb.replace(/\n\{\{- card \}\}\n*$/, '');
    if (sBody === sb || cBody === cb) report(CUSTOM, 0, 'card sensor ' + n + ': state must end {{- card.mood_state }} and card {{- card }}', '');
    if (sBody !== cBody) report(CUSTOM, 0, 'card sensor ' + n + ': the state and card bodies differ', '');
    if (/\bstates\.[a-z_]+\b(?!\()/.test(sBody) || /\bstates\s*\|/.test(sBody)) report(CUSTOM, 0, 'card sensor ' + n + ': iterates states (rate-limited); read entities by id only', '');
    if (/\n {8}variables:/.test(chunk)) report(CUSTOM, 0, 'card sensor ' + n + ': no entity-level variables: (rendered once, when tracking starts)', '');
  }
  // 4. slot scripts
  const cust = readMoodFile(text).customize;
  for (let n = 1; n <= G.SLOTS; n++) {
    const id = 'script.mood_custom_' + n, c = cust[id] || {};
    if (c.mood_slot !== n || c.mood_holds_outdoor !== false || 'mood' in c) report(CUSTOM, 0, id + ': customize must be exactly mood_slot ' + n + ' and mood_holds_outdoor false, with no mood key', JSON.stringify(c));
    const s0 = text.indexOf('\n  mood_custom_' + n + ':\n'), s1 = text.indexOf('\n  mood_custom_' + (n + 1) + ':\n') > 0 ? text.indexOf('\n  mood_custom_' + (n + 1) + ':\n') : text.indexOf('\n  moods_custom_run:\n');
    const sc = s0 < 0 ? '' : text.slice(s0, s1);
    const acts = (sc.match(/^ {6}- (?:#.*\n {8})?(action: [a-z_.]+|condition: template)/gm) || []).map((x) => x.replace(/^.*?(action: |condition: )/, '$1'));
    if (JSON.stringify(acts) !== JSON.stringify(['action: script.mood_begin', 'condition: template', 'action: script.moods_custom_run'])) report(CUSTOM, 0, id + ': the sequence must be mood_begin, the begin.proceed condition, then the awaited script.moods_custom_run', JSON.stringify(acts));
    if (/script\.turn_on/.test(sc.replace(/^\s*#.*$/gm, ''))) report(CUSTOM, 0, id + ': must await the runner, not script.turn_on it', '');
  }
  // 5. no templated actions; the slot slugs are reserved
  fs.readdirSync(PKG).filter((f) => /\.ya?ml$/.test(f)).forEach((f) => {
    const t = fs.readFileSync(path.join(PKG, f), 'utf8');
    if (/action:\s*["']?\{\{/.test(t)) report(path.join(PKG, f), 0, 'a templated action: (every action is a fixed service)', '');
    if (f !== 'moods_custom.yaml' && (/^ {2}mood_custom_[0-9]+:/m.test(t) || /script\.mood_custom_[0-9]+:/.test(t))) report(path.join(PKG, f), 0, 'defines script.mood_custom_*, which is reserved for the generated slots', '');
  });
  // 6. mood_begin's slot block, and "back to Usual"
  const core = fs.readFileSync(path.join(PKG, 'moods_core.yaml'), 'utf8');
  const iVac = core.indexOf('- stop: Vacation mode is on; only Away may run'), iSlot = core.indexOf('slot_refused:'), iWin = core.indexOf('win_state: >-');
  if (!(iVac > 0 && iSlot > iVac && iWin > iSlot)) report(path.join(PKG, 'moods_core.yaml'), 0, "mood_begin's slot refusal must come after the vacation stop and before the window", '');
  ["is_slot: \"{{ slug_clean is match('^custom_[1-6]$') and state_attr(caller, 'mood_slot') is not none }}\"", "s.attributes.get('mood_slot') is not none", "value_template: \"{{ is_slot and slot_card.get('mood') != true }}\"",
    "{%- set w = slot_card.get('mood_window') if is_slot else state_attr(caller, 'mood_window') %}", "{%- set n = slot_card.get('mood_name') if is_slot else state_attr(caller, 'mood_name') %}", "states('input_text.custom_mood_lit_outdoor') == cur"]
    .forEach((x) => { if (core.indexOf(x) < 0) report(path.join(PKG, 'moods_core.yaml'), 0, 'moods_core.yaml is missing the slot line ' + x.slice(0, 80), ''); });
  if (core.split("{%- set w = slot_card.get('mood_window') if is_slot else state_attr(caller, 'mood_window') %}").length !== 3) report(path.join(PKG, 'moods_core.yaml'), 0, 'win_state and window_reason must both take the window from the slot card', '');
  const settings = fs.readFileSync(path.join(PKG, 'moods_settings.yaml'), 'utf8');
  if (settings.indexOf("selectattr('entity_id', 'search', '^input_number[.]moods_.*_order$')") < 0) report(path.join(PKG, 'moods_settings.yaml'), 0, 'moods_settings_usual must reset every input_number.moods_*_order', '');
  if (settings.indexOf("selectattr('entity_id', 'search', '^input_select[.]moods_')") < 0) report(path.join(PKG, 'moods_settings.yaml'), 0, 'moods_settings_usual select regex changed', '');
  const h1 = G.helperIds(1), slotHelpers = [h1.name, h1.on, h1.glyph, h1.steps[0].lights, h1.steps[0].pct];
  slotHelpers.forEach((e) => { if (/^input_select[.]moods_/.test(e) || /^input_number[.]moods_.*_order$/.test(e)) report(path.join(PKG, 'moods_settings.yaml'), 0, '"back to Usual" would reset slot helper ' + e, ''); });
  // 7. placement: one _where (exactly WHERE) and one _order (0..999 by 1) per mood and per slot, nothing else
  const slugs = G.BUILTIN_SLUGS.concat(Array.from({ length: G.SLOTS }, (_, i) => 'custom_' + (i + 1)));
  const seen = {};
  fs.readdirSync(PKG).filter((f) => /\.ya?ml$/.test(f)).forEach((f) => {
    const t = fs.readFileSync(path.join(PKG, f), 'utf8');
    Object.keys(readSection(t, 'input_select')).concat(Object.keys(readSection(t, 'input_number'))).forEach((k) => { if (/^moods_.*_(where|order)$/.test(k)) (seen[k] = seen[k] || []).push(f); });
  });
  const helpers = loadHelpers(PKG);
  const numbers = {}; fs.readdirSync(PKG).filter((f) => /\.ya?ml$/.test(f)).forEach((f) => Object.assign(numbers, readSection(fs.readFileSync(path.join(PKG, f), 'utf8'), 'input_number')));
  slugs.forEach((slug) => {
    const w = 'moods_' + slug + '_where', o = 'moods_' + slug + '_order';
    if ((seen[w] || []).length !== 1) report(PKG, 0, 'input_select.' + w + ' must be defined exactly once', JSON.stringify(seen[w] || []));
    else if (JSON.stringify((helpers['input_select.' + w] || {}).options) !== JSON.stringify(G.WHERE)) report(PKG, 0, 'input_select.' + w + ' must have exactly the WHERE options, Usual first', JSON.stringify((helpers['input_select.' + w] || {}).options));
    if ((seen[o] || []).length !== 1) report(PKG, 0, 'input_number.' + o + ' must be defined exactly once', JSON.stringify(seen[o] || []));
    else { const x = numbers[o] || {}; if (x.min !== 0 || x.max !== 999 || x.step !== 1 || 'initial' in x) report(PKG, 0, 'input_number.' + o + ' must be min 0, max 999, step 1, no initial', JSON.stringify(x)); }
  });
  Object.keys(seen).forEach((k) => { const slug = k.replace(/^moods_/, '').replace(/_(where|order)$/, ''); if (slugs.indexOf(slug) < 0) report(PKG, 0, k + ' belongs to no mood', ''); });
  Object.keys(helpers).filter((id) => /^input_select\.(moods_|custom_mood_)/.test(id)).forEach((id) => { if ('initial' in helpers[id]) report(PKG, 0, id + ' must not have initial: (it would reset on every restart)', ''); });
  G.WHERE.forEach((t) => { const m = /^(Only on|Not on) the (.+) Palm$/.exec(t); if (m) { const key = m[2].toLowerCase().replace(/[^a-z0-9_]+/g, '_'); if (!helpers['input_select.moods_panel_' + key + '_night_hours']) report(PKG, 0, 'WHERE names the ' + m[2] + ' Palm, but there are no moods_panel_' + key + '_* helpers', ''); } });
  // the dashboard: every mood's placement tiles and Set-a-mood tile, and each slot's tiles
  const dash = fs.readFileSync(DASH, 'utf8');
  G.BUILTIN_SLUGS.forEach((slug) => ['entity: input_select.moods_' + slug + '_where', 'entity: input_number.moods_' + slug + '_order', 'entity_id: script.mood_' + slug].forEach((x) => { if (dash.indexOf(x) < 0) report(DASH, 0, 'the dashboard has no ' + x, ''); }));
  for (let n = 1; n <= G.SLOTS; n++) {
    if (dash.split('navigation_path: /palm-moods/custom-' + n + '\n').length !== 3) report(DASH, 0, 'My moods needs a tile for slot ' + n + ' (tap and icon tap to /palm-moods/custom-' + n + ')', '');
    if (dash.split('                entity_id: script.mood_custom_' + n + '\n').length < 3) report(DASH, 0, 'Set a mood needs a tile for slot ' + n, '');
  }
  // 8. the README's deploy gate exempts the slots from "has mood: true"
  const readme = fs.readFileSync(path.join(UI, '..', 'ha', 'README.md'), 'utf8');
  if (!readme.split('\n').some((l) => /mood: true/.test(l) && /script\.mood_custom_\*/.test(l) && /except|not|no /i.test(l))) report(path.join(UI, '..', 'ha', 'README.md'), 0, 'the deploy gate must exempt script.mood_custom_* from "has mood: true"', '');
  console.log('custom moods: ' + G.SLOTS + ' slots of ' + G.STEPS + ' steps match gen-custom.js; ' + Object.keys(opts).length + ' frozen option lists; placement for ' + slugs.length + ' moods (' + G.BUILTIN_SLUGS.length + ' built-in)');
} catch (e) { report(path.join(UI, 'dev', 'gen-custom.js'), 0, 'custom mood check failed: ' + e.message, String(e.stack || '').split('\n')[1] || ''); }

console.log(findings ? findings + ' finding(s)' : 'clean: ' + files.map((f) => path.basename(f)).join(', '));
process.exit(findings ? 1 : 0);
