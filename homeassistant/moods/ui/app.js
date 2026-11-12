/* Palm Moods: the Ember UI.
   Contract: docs/ARCHITECTURE.md, section 3. Nothing here names a mood: moods are Home Assistant
   data (every script with mood: true). The only mood names in ui/ are mock.js's demo data.
   Classic script. Never logs the config or the token. */
(function () {
'use strict';

/* ===================== tuning: the one place for levels and times ===================== */
/* Window brightness (Shell.setBrightness, 0..1; the shell clamps 0 to its floor, about 1/255). */
var BRIGHTNESS = {
  night:     0,      // night face, nobody near: as dark as the panel goes
  nightWake: 0.04,   // night, after a touch or a hand near the phone (the dim interactive level)
  rest:      0.10,   // day face after a quiet minute
  idle:      0.18,   // day face
  active:    0.40,   // deck, holding, confirming (day)
  brightRoom: 1.8,   // day levels are multiplied by this when the room is bright (lux above LUX.bright)...
  max:       0.85    // ...up to this
};
var TIMING = {
  holdMs: 600,          // a completed hold sets the mood (swiping never does)
  confirmMs: 8000,      // a confirmation mark waits this long for its entity
  undoMs: 10000,        // Undo is offered this long
  returnMs: 4000,       // applied card -> idle face
  deckIdleMs: 20000,    // untouched deck -> idle face
  restMs: 60000,        // quiet face -> rest (drift and colon stop, a touch dimmer)
  nightWakeMs: 12000,   // a woken night face goes dark again after this
  offlineNoteMs: 5000,  // the face says "Reconnecting" only after this long without HA
  ackMs: 5000,          // a service call with no result after this long means the link is dead
  clockTapGapMs: 400,   // escape hatch: five taps on the clock within 3 s, each under this gap after the last
  clockTapWindowMs: 3000
};
var LUX = { darkBelow: 3, lightAbove: 6, darkDwellMs: 30000, lightDwellMs: 10000, bright: 150, brightOff: 110 };
var HEALTH = { hotC: 42, coolC: 40 };

var html = document.documentElement;
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function now() { return Date.now(); }

/* ===================== debug trail (no secrets): window.__moods ===================== */
var trail = [];
function note(kind, detail) { trail.push({ t: now(), kind: kind, detail: detail }); if (trail.length > 300) trail.shift(); }

/* ===================== shell ===================== */
var Shell = window.Shell || null;
function shellCall(name, args) {
  if (!Shell || typeof Shell[name] !== 'function') return undefined;
  try { return Shell[name].apply(Shell, args || []); } catch (e) { return undefined; }
}
function haptic(kind) { note('haptic', kind); if (!STATIC) shellCall('haptic', [kind]); }
function shellLog(level, msg) { shellCall('log', [level, String(msg).slice(0, 300)]); }
window.addEventListener('error', function (e) { shellLog('error', (e && e.message ? e.message : 'error') + (e && e.lineno ? ' @' + e.lineno : '')); });

/* ===================== params and mode ===================== */
var Q = new URLSearchParams(location.search);
var START = Q.get('state'); if (!/^(idle|deck|applied)$/.test(START || '')) START = 'idle';
var FORCE_NIGHT = Q.get('night') === '1';
var STATIC = Q.get('static') === '1';
var FPS = Q.get('fps') === '1';
/* ?time=HH:MM pins the clock (and the night hours) for screenshots */
var PIN = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(Q.get('time') || '');
function clockNow() { var d = new Date(); if (PIN) d.setHours(+PIN[1], +PIN[2]); return d; }

var shellCfg = null;
if (Shell && typeof Shell.getConfig === 'function') {
  try { var raw = Shell.getConfig(); var o = JSON.parse(raw); if (o && typeof o === 'object') shellCfg = o; } catch (e) { shellCfg = null; }
}
function cfgStr(k) { var v = shellCfg && shellCfg[k]; return typeof v === 'string' ? v.trim() : ''; }
function hhmm(v, d) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(v || '') ? v : d; }

var MODE, haUrl = '', haToken = '';
if (Q.get('mock') === '1') MODE = 'mock';
else if (Q.get('ha') && Q.get('token')) { MODE = 'direct'; haUrl = Q.get('ha'); haToken = Q.get('token'); }
else if (shellCfg && shellCfg.mock !== true && cfgStr('haUrl') && cfgStr('token')) { MODE = 'shell'; haUrl = cfgStr('haUrl'); haToken = cfgStr('token'); }
else MODE = 'mock';
var DEMO = Q.get('demo') === '1' && !STATIC && MODE === 'mock';   // the demo loop sets moods: never against a real house

var CFG = {
  panel: (Q.get('panel') || cfgStr('panel') || (MODE === 'mock' ? 'bedroom' : 'default')).toLowerCase(),
  nightStart: hhmm(cfgStr('nightStart'), '22:00'),
  nightEnd: hhmm(cfgStr('nightEnd'), '07:00'),
  /* the temperature on the idle status line: config key "tempEntity" (the shell passes unknown keys
     through), or ?temp= in a browser: a sensor (its state) or a climate entity (its
     current_temperature attribute). No temperature is shown without one. */
  tempEntity: Q.get('temp') || cfgStr('tempEntity') || (MODE === 'mock' ? MockHA.tempEntity : '')
};
if (!Moods.ENTITY_RE.test(CFG.tempEntity)) CFG.tempEntity = '';
note('mode', MODE);

if (FORCE_NIGHT) html.classList.add('night');
if (STATIC) html.classList.add('static');

/* ===================== elements ===================== */
var skiesEl = $('skies'), face = $('face'), deck = $('deck'), track = $('track'), pager = $('pager');
var clockEl = $('clock'), statusEl = $('status'), faceGlyph = $('faceGlyph'), faceDots = $('faceDots'), faceUndo = $('faceUndo'), tbTime = $('tbTime');
var faceNote = $('faceNote'), healthEl = $('health');
function U(n) { return 'calc(var(--u)*' + n + ')'; }

if (MODE === 'mock') { var tag = document.createElement('div'); tag.className = 'demo-tag'; tag.textContent = 'Demo'; $('app').appendChild(tag); }

/* ===================== Home Assistant connection ===================== */
var store = new EntityStore();
var client = null, everReady = false, dataReady = false, offlineSince = now();
var CORE = ['input_text.house_mood', 'input_text.house_mood_previous', 'input_text.house_mood_notice'];
if (CFG.tempEntity) CORE.push(CFG.tempEntity);
/* This panel's two settings on the Home Assistant "Moods" dashboard (ha/packages/moods/moods_settings.yaml):
   input_select.moods_panel_<panel>_night_hours and _screen. They ride the first subscription like the
   mood helpers. Anything the UI cannot read (no helper, unknown, unavailable, the first option, an
   option it does not recognise) leaves the phone on its own config: the night hours it was
   provisioned with and the usual BRIGHTNESS levels. */
var PKEY = CFG.panel.replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 32);
var SET = { night: 'input_select.moods_panel_' + PKEY + '_night_hours', screen: 'input_select.moods_panel_' + PKEY + '_screen' };
if (!PKEY || !Moods.ENTITY_RE.test(SET.night) || !Moods.ENTITY_RE.test(SET.screen)) SET = { night: '', screen: '' };
if (SET.night) CORE.push(SET.night, SET.screen);
var sim = null;

function startClient() {
  var socketFactory = null;
  if (MODE === 'mock') {
    var set = MockHA.moods(Q.get('mockset'));
    var sorted = set.filter(function (m) { return m.attributes && m.attributes.mood === true; })
      .sort(function (a, b) { return (Number(a.attributes.mood_order) || 1000) - (Number(b.attributes.mood_order) || 1000); });
    var mq = Q.get('mood'), init = sorted[0], i;
    function slugOf(m) { return m.entity_id.replace(/^script\.mood_/, ''); }   // as the package does
    if (mq != null && /^\d+$/.test(mq) && sorted[+mq]) init = sorted[+mq];
    else if (mq) for (i = 0; i < sorted.length; i++) if (slugOf(sorted[i]) === mq) init = sorted[i];
    var initSlug = init ? slugOf(init) : '';
    // as in the mockup: the previous mood is the first one, or a night mood when the first is current
    var prevSlug = '';
    if (sorted[0] && sorted[0] !== init) prevSlug = slugOf(sorted[0]);
    else for (i = 0; i < sorted.length; i++) if (sorted[i] !== init && sorted[i].attributes.mood_night) { prevSlug = slugOf(sorted[i]); break; }
    if (!prevSlug && sorted[1]) prevSlug = slugOf(sorted[1]);
    sim = new HouseSim({ moods: set, token: null, never: Q.has('never') ? Q.get('never') : MockHA.never, initial: initSlug, previous: prevSlug,
                         tempEntity: CFG.tempEntity, temp: 68, speed: Q.get('speed') ? Number(Q.get('speed')) || 1 : 1,
                         clock: clockNow });   // ?time= also pins the mock house's clock, so its mood windows follow it
    socketFactory = function () { return new MockHA.MockSocket(sim); };
    var outs = Number(Q.get('outside'));
    if (outs > 0) setInterval(function () { sim.outside(); }, outs * 1000);
    haUrl = 'mock://'; haToken = 'mock';
  }
  client = new HAClient({
    url: haUrl, token: haToken, socket: socketFactory,
    onStatus: onStatus,
    onError: function (e) { shellLog('error', 'event handler: ' + (e && e.message)); },
    onSubError: function (key, e) { shellLog('warn', 'subscription ' + key + ' failed: ' + (e && e.code)); }
  });
  client.subscribe('core', { type: 'subscribe_entities', include: { domains: ['script'], entities: CORE } }, function (ev, fresh) {
    var ch = store.apply('core', ev, fresh);
    if (fresh) { store.drop('cache'); }
    onEntities(ch, fresh);
  });
  updateTouchSub();
  client.start();
}

function onStatus(s) {
  note('status', s);
  if (s === 'ready') { everReady = true; offlineSince = 0; }
  else if (!offlineSince) offlineSince = now();
  renderOffline();
  if (s !== 'ready' && offlineSince) {
    var due = offlineSince + TIMING.offlineNoteMs - now();
    if (due > 0) later('offlineNote', renderOffline, due + 50);
  }
}
function canSet() { return !!(client && client.ready() && dataReady && !(health && health.nowifi)); }

var touchSig = '';
function updateTouchSub() {
  var ids = {}, list = [];
  moods.forEach(function (m) { m.touches.forEach(function (t) { if (!/^script\./.test(t.entity) && CORE.indexOf(t.entity) < 0 && !ids[t.entity]) { ids[t.entity] = 1; list.push(t.entity); } }); });
  list.sort();
  var sig = list.join(',');
  if (sig === touchSig) return;
  touchSig = sig;
  if (!list.length) { client.subscribe('touch', null); store.drop('touch'); return; }
  client.subscribe('touch', { type: 'subscribe_entities', entity_ids: list }, function (ev, fresh) {
    onEntities(store.apply('touch', ev, fresh), false);
  });
}

function onEntities(ids, fresh) {
  var scripts = fresh, mood = false, temp = false, settings = false;
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    if (id.charCodeAt(0) === 115 && id.indexOf('script.') === 0) scripts = true;   // 's'
    else if (id === 'input_text.house_mood' || id === 'input_text.house_mood_previous') mood = true;
    else if (id === 'input_text.house_mood_notice') onNotice();
    else if (id === CFG.tempEntity) temp = true;
    if (SET.night && (id === SET.night || id === SET.screen)) settings = true;
  }
  if (fresh && !dataReady) {
    dataReady = true; refreshMoods('boot'); onHouseMood(true); renderOffline(); bootReady();
    computeNight();   // the panel's night-hours and screen settings may have arrived with this first dump
    // the face may have been drawn from the cache, and an unchanged mood does not redraw it: bring
    // the status line (the temperature) up to the live data
    if (view === 'idle') renderStatus();
    return;
  }
  // a later full dump (a reconnect) still lets a shrink settle: it may land mid script reload
  if (scripts) { if (fresh) refreshMoods('fresh'); else later('moods', function () { refreshMoods('diff'); }, 300); }
  if (mood || fresh) onHouseMood(false);
  if (temp && view === 'idle') renderStatus();
  if (settings) { note('settings', panelSettings()); computeNight(); }
  checkMarks();
}

/* ===================== moods ===================== */
var moods = [], N = 0, moodSig = null, rebuildPending = false, shrinkSeen = 0, slugWarned = {};
function moodIds() { var a = store.ids('core'); if (!a.length) a = store.ids('cache'); return a.filter(function (id) { return id.indexOf('script.') === 0; }); }
/* kind: 'boot' (first data, the cache, or a deck that just closed: take the list as it is),
         'fresh' (a full dump after a reconnect), 'diff' (a change event) */
function refreshMoods(kind) {
  var list = Moods.fromStates(store.get, moodIds(), CFG.panel);
  var sig = Moods.signature(list);
  if (sig === moodSig) { shrinkSeen = 0; return; }
  // a script reload removes entities a moment before re-creating them: let a shrink settle first
  if (kind !== 'boot' && list.length < N) {
    if (!shrinkSeen) shrinkSeen = now();
    if (now() - shrinkSeen < 2000) { later('moods', function () { refreshMoods('diff'); }, 2100 - (now() - shrinkSeen)); return; }
  }
  shrinkSeen = 0;
  if (view === 'deck' && N > 0 && kind === 'diff') { rebuildPending = true; return; }   // never rebuild under a finger
  if (view === 'deck' && N > 0 && (hold || locked)) { rebuildPending = true; return; }
  rebuildPending = false;
  moodSig = sig; moods = list; N = list.length;
  note('moods', list.map(function (m) { return m.slug; }).join(','));
  list.forEach(function (m) {
    if (m.slugMismatch && !slugWarned[m.id]) { slugWarned[m.id] = 1; shellLog('warn', m.id + ' has mood_slug "' + m.slugMismatch + '"; using "' + m.slug + '" from its entity id'); }
  });
  build();
  if (client) updateTouchSub();
  cur = idxOf(shownSlug);
  if (view === 'deck') { openDeck(Math.max(0, cur)); }
  else { renderFace(); easeSkyTo(skyIdx()); }
  computeNight();
  saveCache();
}
function idxOf(slug) { if (!slug) return -1; for (var i = 0; i < N; i++) if (moods[i].slug === slug) return i; return -1; }
function cleanSlug(s) { s = String(s == null ? '' : s).trim().toLowerCase(); return (s === 'unknown' || s === 'unavailable') ? '' : s; }
function haValue(id) { var e = store.get(id); return e ? cleanSlug(e.s) : ''; }

/* ===================== cache: the last moods, so a reload draws at once ===================== */
var CACHE_KEY = 'moods.cache.v1';
function saveCache() {
  if (MODE === 'mock' || !dataReady) return;
  // never store a list that is still settling (a mood shown on the deck but gone from the store)
  for (var i = 0; i < moods.length; i++) if (!store.get(moods[i].id)) return;
  try {
    var a = {};
    moods.forEach(function (m) { var e = store.get(m.id); if (e) a[m.id] = { s: e.s, a: e.a }; });
    // helpers keep only their state; a climate tempEntity also keeps the one attribute shown
    CORE.forEach(function (id) {
      var e = store.get(id);
      if (e) a[id] = { s: e.s, a: id === CFG.tempEntity && e.a && e.a.current_temperature != null ? { current_temperature: e.a.current_temperature } : {} };
    });
    localStorage.setItem(CACHE_KEY, JSON.stringify({ t: now(), panel: CFG.panel, a: a }));
  } catch (e) {}
}
function loadCache() {
  if (MODE === 'mock') return;
  try {
    var c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!c || !c.a || c.panel !== CFG.panel || now() - c.t > 30 * 86400000) return;
    store.apply('cache', { a: c.a }, true);
    shownSlug = haValue('input_text.house_mood');
    refreshMoods('boot');
  } catch (e) {}
}

/* ===================== build ===================== */
var skies = [], cards = [], dots = [], cardIn = [];
var DASH = '<svg class="rd" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5.4"/></svg>';
var NEUTRAL = Moods.palette(Moods.DEFAULT_PALETTE);
var NEUTRAL_SKY = Moods.sky(NEUTRAL, 'neutral', false);
var DEFAULT_ACCENT = Moods.toHex(NEUTRAL.accent), DEFAULT_INK = Moods.toHex(NEUTRAL.ink);

function skyEl(pal, layers, i) {
  var s = document.createElement('div');
  s.className = 'sky';
  s.style.background = Moods.toHex(pal.base);
  s.innerHTML = layers.map(function (g, k) {
    var w = g[3], h = g[4];
    return '<i class="glow a' + g[7] + (g[0] === 'band' ? ' band' : '') + '" style="left:' + g[5] + '%;top:' + g[6] + '%;width:' + U(w) + ';height:' + U(h) +
      ';margin:' + U(-h / 2) + ' 0 0 ' + U(-w / 2) + ';background:' + Moods.layerBackground(g[0], g[1], g[2]) + ';animation-delay:-' + (11 + (i % 7) * 7 + k * 13) + 's"></i>';
  }).join('');
  return s;
}

function build() {
  skiesEl.innerHTML = ''; track.innerHTML = ''; pager.innerHTML = ''; faceDots.innerHTML = '';
  skies = []; cards = []; dots = []; cardIn = [];
  moods.forEach(function (m, i) {
    var s = skyEl(m.pal, m.sky, i);
    skiesEl.appendChild(s); skies.push(s);
    var acc = m.pal.accent;
    var c = document.createElement('section');
    c.className = 'card';
    c.style.cssText = '--ink:' + Moods.toHex(m.pal.ink) + ';--accent:' + Moods.toHex(acc) + ';--accentA:' + Moods.rgba(acc, .5) + ';--accentB:' + Moods.rgba(acc, .16) +
      ';--soft:rgba(255,248,240,.76);--meta:rgba(255,244,232,.62);--faint:rgba(255,240,225,.42);--line:rgba(255,240,225,.24);--core:#fff4e4';
    c.innerHTML =
      '<div class="card-in">' +
        '<div class="bloom"></div>' +
        Glyphs.svg(m.glyph, 'glyph') +
        '<div class="scope' + (m.scope ? '' : ' bare') + '"><span>' + esc(m.scope) + '</span><b class="now">On now</b></div>' +
        '<h2 class="name"><span>' + esc(m.name) + '</span></h2>' +
        '<p class="desc"><span>' + esc(m.tagline) + '</span></p>' +
        '<div class="touches"><span class="tr">' + m.touches.map(function (t) { return '<span class="t"><i class="mk">' + DASH + '</i><span class="lb">' + esc(t.label) + '</span></span>'; }).join('') + '</span></div>' +
        '<p class="note"><span></span></p>' +
        '<div class="hold"><svg class="ring" viewBox="0 0 64 64"><circle class="ring-t" cx="32" cy="32" r="30"/><circle class="ring-p" cx="32" cy="32" r="30"/></svg><i class="ember"></i></div>' +
        '<p class="prompt"><span class="p0">Hold to set</span><span class="p1">Keep holding</span><span class="p2">' + esc(m.name) + ' is on</span><span class="p3">' + offlineWord() + '</span></p>' +
        '<button class="undo" type="button"></button>' +
      '</div>';
    track.appendChild(c); cards.push(c); cardIn.push(c.firstChild);
    var d = document.createElement('i'); d.className = 'pd';
    d.innerHTML = '<b class="pdd"></b><b class="pdp" style="--pdc:' + Moods.rgba(acc, .8) + '"></b>';
    pager.appendChild(d); dots.push([d.firstChild, d.lastChild]);
    faceDots.appendChild(document.createElement('i'));
  });
  var ns = skyEl(NEUTRAL, NEUTRAL_SKY, 0);   // the room with no mood (none set yet, or unknown)
  skiesEl.appendChild(ns); skies.push(ns);
  skyOp = [];
  // pager and face dots for 1 to ~20 moods
  var pw = N <= 9 ? 20 : Math.max(8, Math.floor(300 / N) - 4), pg = N <= 9 ? 5 : 4;
  pager.style.setProperty('--pw', pw); pager.style.setProperty('--pg', pg);
  pager.classList.toggle('one', N <= 1);
  faceDots.style.setProperty('--fdg', N <= 9 ? 10 : Math.max(4, Math.floor(220 / N) - 5));
  faceDots.style.setProperty('--fdw', N <= 9 ? 16 : 10);
  faceDots.style.display = N <= 1 ? 'none' : '';
  deck.classList.toggle('none', N === 0);
  fitNames();
}
function skyIdx() { return cur >= 0 ? cur : N; }

/* tidy description lines (no text-wrap:balance in Chrome 101): prefer breaking between sentences,
   otherwise balance the line lengths */
function balance() {
  cards.forEach(function (c, i) {
    var s = c.querySelector('.desc span'), text = moods[i] ? moods[i].tagline : '';
    s.style.maxWidth = '';
    s.parentNode.style.fontSize = '';
    s.textContent = text;
    var full = s.parentNode.clientWidth, h = s.offsetHeight;
    if (!full || !text) return;
    // more than two lines: a smaller italic keeps the touches row clear
    var lh = parseFloat(getComputedStyle(s.parentNode).lineHeight) || 24;
    if (h > lh * 2.5) { s.parentNode.style.fontSize = 'calc(var(--u)*15.5)'; h = s.offsetHeight; }
    var parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
    if (parts.length > 1) {
      s.innerHTML = parts.map(function (p) { return '<b style="display:inline-block;font-weight:inherit;white-space:nowrap">' + esc(p.trim()) + '</b>'; }).join(' ');
      var ok = s.offsetHeight <= h + 6;
      Array.prototype.forEach.call(s.children, function (b) { if (b.getBoundingClientRect().width > full + 0.5) ok = false; });
      if (ok) return;
      s.textContent = text;
    }
    var lo = full * 0.45, hi = full;
    for (var k = 0; k < 9; k++) { var mid = (lo + hi) / 2; s.style.maxWidth = mid + 'px'; if (s.offsetHeight > h) lo = mid; else hi = mid; }
    s.style.maxWidth = Math.ceil(hi + 1) + 'px';
  });
}
/* shrink a single-line run to fit (long names, extra touches, long status lines, fallback fonts) */
function fitTo(el, avail) {
  if (!el) return;
  el.style.transform = '';
  var w = el.offsetWidth;
  el.style.transform = (w > avail && avail > 0) ? 'scale(' + (avail / w).toFixed(3) + ')' : '';
}
function fitNames() {
  balance();
  cards.forEach(function (c) {
    var h = c.querySelector('.name'); fitTo(h.firstChild, h.clientWidth);
    var t = c.querySelector('.touches'); fitTo(t.firstChild, t.clientWidth);
    var sc = c.querySelector('.scope'); fitTo(sc.firstChild, sc.clientWidth * 0.7);
  });
  fitStatus();
}
function fitStatus() { var sw = statusEl.firstChild; if (sw) fitTo(sw, statusEl.clientWidth); }

/* ===================== state ===================== */
var cur = -1;              // index of the mood shown as current
var shownSlug = '';        // what the face shows (HA's house_mood, or our own just-set mood)
var view = 'idle';
var pos = 0, tw = 0;
var timers = {};
var undoUntil = 0, undoSlug = '';
var locked = false;        // a confirmation is running on a card
var pend = null;           // the mood this phone just set: { idx, slug, t0, prevSlug, items, done }
var undoPend = null;
function clear(name) { if (timers[name]) { clearTimeout(timers[name]); timers[name] = 0; } }
function later(name, fn, ms) { clear(name); timers[name] = setTimeout(function () { timers[name] = 0; fn(); }, ms); }
function measure() { tw = track.clientWidth || window.innerWidth; }
function setView(v) {
  // a deck opened from a night face stays night (see computeNight)
  if (v === 'deck' && view !== 'deck') deckFromNight = isNight;
  else if (v !== 'deck') deckFromNight = false;
  view = v; html.setAttribute('data-view', v); computeNight();
}

/* rest: after a quiet minute on the face, stop the drift and the colon and dim a touch */
function wakeRest() { clear('rest'); if (html.classList.contains('rest')) { html.classList.remove('rest'); updateBrightness(); } }
function armRest() { wakeRest(); if (view === 'idle' && !STATIC) later('rest', function () { if (view === 'idle') { html.classList.add('rest'); updateBrightness(); } }, TIMING.restMs); }

/* ===================== night and brightness ===================== */
var isNight = false, deckFromNight = false, woken = false, luxDark = false, luxBright = false, luxLit = false, lastB = null, lux = null;
function minutes(s) { var p = s.split(':'); return (+p[0]) * 60 + (+p[1]); }
/* The panel's settings from Home Assistant, each checked here (section 3 of the contract):
   night hours "HH:MM to HH:MM" (equal times: no night by the hours), or "No night hours" (none by
   the hours; a dark room and the Lights Out face still bring night); the screen as
   "<words> (<50..150>%)" of the usual day levels, one plain whole number (a sign or a decimal: usual). */
var NIGHT_RE = /^([01]\d|2[0-3]):([0-5]\d) to ([01]\d|2[0-3]):([0-5]\d)$/;
function setting(id) { var e = id ? store.get(id) : null; return e && typeof e.s === 'string' ? e.s.trim() : ''; }
function nightPair() {
  var s = setting(SET.night), m = NIGHT_RE.exec(s);
  if (m) return { from: m[1] + ':' + m[2], to: m[3] + ':' + m[4], source: 'ha' };
  if (/^no night hours$/i.test(s)) return { from: '00:00', to: '00:00', source: 'ha' };
  return { from: CFG.nightStart, to: CFG.nightEnd, source: 'config' };
}
function screenScale() {
  var n = setting(SET.screen).match(/-?[0-9]+(?:\.[0-9]+)?/g);
  if (!n || n.length !== 1 || !/^[0-9]+$/.test(n[0])) return 1;
  var v = +n[0];
  return v >= 50 && v <= 150 ? v / 100 : 1;
}
function panelSettings() { var p = nightPair(); return { night: p.from + '-' + p.to, nightFrom: p.source, screen: screenScale() }; }
function inNightHours() {
  var pair = nightPair();
  var a = minutes(pair.from), b = minutes(pair.to);
  if (a === b) return false;
  var d = clockNow(), m = d.getHours() * 60 + d.getMinutes();
  return a < b ? (m >= a && m < b) : (m >= a || m < b);   // 22:00-07:00 crosses midnight
}
function computeNight() {
  var m = cur >= 0 ? moods[cur] : null;
  // A mood_night mood (Lights Out) darkens the idle face only, and only while the room is not lit:
  // after a night on Lights Out the face is the day face again once someone opens the curtains
  // (or turns a lamp on). Hours and a dark room darken the deck too. A deck opened from a night
  // face stays night until it closes or the room is lit, so opening it from the Lights Out face in
  // a dim room keeps the dim night level instead of jumping to the day deck's (10 -> 102 of 255).
  var hours = FORCE_NIGHT || inNightHours();
  var n = hours || luxDark || (!luxLit && (!!(m && m.night && view === 'idle') || (view === 'deck' && deckFromNight)));
  if (n !== isNight) {
    isNight = n;
    html.classList.toggle('night', n);
    note('night', n);
    if (!n) woken = false;
    renderFace(); showFaceUndo();
  }
  // the deck's night colours follow the night only while the deck is showing, so a deck fading out
  // into a Lights Out face keeps its own colours to the end
  if (view === 'deck') html.classList.toggle('dn', n);
  updateBrightness();
}
function desiredBrightness() {
  if (isNight) return (view === 'deck' || woken) ? BRIGHTNESS.nightWake : BRIGHTNESS.night;
  var b = view === 'deck' ? BRIGHTNESS.active : (html.classList.contains('rest') ? BRIGHTNESS.rest : BRIGHTNESS.idle);
  b = Math.min(BRIGHTNESS.max, b * screenScale());   // "Screen by day" (1 unless the dashboard says otherwise)
  if (luxBright) b = Math.min(BRIGHTNESS.max, b * BRIGHTNESS.brightRoom);
  return Math.round(b * 1000) / 1000;
}
/* A change is eased in a few steps (about 0.4 s) rather than jumped: on the LCD a jump of up to
   18x (night wake to a bright-room deck) reads as a flash. Geometric steps, so each looks equal.
   lastB is always the target; force (start, resume) sets it at once. */
var lastSent = null, RAMP_STEPS = 4, RAMP_MS = 100;
function sendBrightness(v) { lastSent = v; shellCall('setBrightness', [v]); }
function updateBrightness(force) {
  var b = desiredBrightness();
  if (!force && b === lastB) return;
  lastB = b;
  note('brightness', b);
  clear('ramp');
  var from = lastSent;
  if (force || STATIC || from == null || from === b) { sendBrightness(b); return; }
  var lo = Math.max(Math.min(from, b), 0.004), k = 1;   // 0 is the shell's floor, about 1/255
  (function step() {
    if (k >= RAMP_STEPS) { sendBrightness(b); return; }
    var t = k / RAMP_STEPS, a = Math.max(from, 0.004), z = Math.max(b, 0.004);
    var v = Math.round(a * Math.pow(z / a, t) * 1000) / 1000;
    k++;
    sendBrightness(Math.max(lo, v));
    later('ramp', step, RAMP_MS);
  })();
}
/* someone is here: a touch, or a hand near the phone */
function wakeNight() {
  if (!isNight) return;
  woken = true;
  updateBrightness();
  later('woken', sleepAgain, TIMING.nightWakeMs);
}
function sleepAgain() {
  if (view === 'idle') { woken = false; updateBrightness(); } else later('woken', sleepAgain, TIMING.nightWakeMs);
}
function onLux(l) {
  if (typeof l !== 'number' || !isFinite(l)) return;
  if (!luxDark && l < LUX.darkBelow) { if (!timers.luxDark) later('luxDark', function () { luxDark = true; computeNight(); }, LUX.darkDwellMs); }
  else if (!luxDark) clear('luxDark');
  if (luxDark && l > LUX.lightAbove) { if (!timers.luxLight) later('luxLight', function () { luxDark = false; computeNight(); }, LUX.lightDwellMs); }
  else if (luxDark) clear('luxLight');
  // lit: above LUX.lightAbove for the light dwell (at once for the first reading); unlit as soon as
  // it falls to LUX.lightAbove or below (Lights Out at 21:30 in a room that settles at 4 lux from a
  // streetlight goes dark at once). Becoming lit is slow and ending it fast, so it cannot flicker.
  var first = lux === null;
  lux = l;
  if (first) setLit(l > LUX.lightAbove);
  else if (l <= LUX.lightAbove) { clear('luxLit'); setLit(false); }
  else if (!luxLit && !timers.luxLit) later('luxLit', function () { setLit(true); }, LUX.lightDwellMs);
  var br = luxBright ? l > LUX.brightOff : l > LUX.bright;
  if (br !== luxBright) { luxBright = br; updateBrightness(); }
}
function setLit(v) { if (v !== luxLit) { luxLit = v; note('lit', v); computeNight(); } }

/* ===================== shell events ===================== */
var health = { hot: false, nowifi: false };
window.__onShell = function (type, p) {
  if (!p || typeof p !== 'object') p = {};
  if (type === 'sensor') {
    if ('lux' in p) onLux(p.lux);
    // at night a hand near the phone only lights the face; it does not restart the (paused) drift
    if (p.near === true) { note('near', true); wakeNight(); if (view === 'idle' && !isNight) armRest(); }
  } else if (type === 'power') {
    var t = Number(p.tempC);
    if (isFinite(t)) { var hot = health.hot ? t > HEALTH.coolC : t > HEALTH.hotC; if (hot !== health.hot) { health.hot = hot; renderHealth(); } }
  } else if (type === 'net') {
    if (typeof p.wifi === 'boolean') {
      var nw = !p.wifi, back = health.nowifi && !nw;
      if (nw !== health.nowifi) { health.nowifi = nw; renderHealth(); renderOffline(); }
      // Wi-Fi back: retry now (resets the backoff). Anything else (Wi-Fi gone, an RSSI-only update,
      // the replay after a page load): at most prove a quiet socket is alive; the backoff is kept.
      if (client) { if (back) client.kick(); else client.probe(); }
    }
  } else if (type === 'lifecycle') {
    if (p.state === 'resume') { updateBrightness(true); if (client) client.kick(); computeNight(); }
  }
};

var THERMO = '<svg viewBox="0 0 12 12"><path d="M6 1.5a1.4 1.4 0 0 1 1.4 1.4v4.4a2.4 2.4 0 1 1-2.8 0V2.9A1.4 1.4 0 0 1 6 1.5z"/></svg>';
var NOWIFI = '<svg viewBox="0 0 12 12"><path d="M1.5 5a6.5 6.5 0 0 1 9 0M3.2 6.9a4 4 0 0 1 5.6 0M5.2 8.8a1.2 1.2 0 0 1 1.6 0M2 1.5l8 9"/></svg>';
function renderHealth() {
  var parts = [];
  if (health.hot) parts.push(THERMO + '<span>Phone warm</span>');
  if (health.nowifi) parts.push(NOWIFI + '<span>No Wi-Fi</span>');
  healthEl.innerHTML = parts.join('');
  healthEl.classList.toggle('on', parts.length > 0);
  note('health', JSON.stringify(health));
}

/* ===================== offline / notes ===================== */
/* a short-lived note on the face (a refused Undo, a mood that never took): below the connection notes */
var flash = { text: '', until: 0 };
function faceFlash(text, ms) {
  flash = { text: text, until: now() + (ms || 8000) };
  renderOffline();
  later('flash', function () { flash = { text: '', until: 0 }; renderOffline(); }, (ms || 8000) + 20);
}
function offlineWord() {
  if (client && client.status() === 'auth_invalid') return 'Token rejected';
  return everReady ? 'Reconnecting' : 'Connecting';
}
function renderOffline() {
  var off = !canSet();
  html.classList.toggle('offline', off);
  var w = offlineWord();
  cards.forEach(function (c) { var p = c.querySelector('.p3'); if (p.textContent !== w) p.textContent = w; });
  var txt = '';
  if (client && client.status() === 'auth_invalid') txt = 'Home Assistant turned the token down';
  else if (off && offlineSince && now() - offlineSince >= TIMING.offlineNoteMs) txt = w;
  else if (flash.text && now() < flash.until) txt = flash.text;
  else if (dataReady && N === 0) txt = 'No moods in Home Assistant yet';
  if (txt) faceNote.textContent = txt;
  faceNote.classList.toggle('on', !!txt);
}

/* ===================== clock ===================== */
function tick() {
  var d = clockNow(), h = d.getHours(), mm = d.getMinutes();
  var h12 = h % 12 || 12, ap = h < 12 ? 'am' : 'pm', m2 = (mm < 10 ? '0' : '') + mm;
  clockEl.innerHTML = '<span class="cw">' + h12 + '<span class="colon">:</span>' + m2 + '<span class="ampm">' + ap + '</span></span>';
  tbTime.textContent = h12 + ':' + m2 + ' ' + ap;
  computeNight();
  setTimeout(tick, 60000 - (Date.now() % 60000) + 30);
}

/* ===================== idle face ===================== */
function tempText() {
  if (!CFG.tempEntity) return '';
  var e = store.get(CFG.tempEntity);
  if (!e) return '';
  // a sensor's state is the temperature; a climate entity's state is its HVAC mode, so read the
  // room temperature it reports (current_temperature) instead
  var v = /^climate\./.test(CFG.tempEntity) ? parseFloat(e.a && e.a.current_temperature) : parseFloat(e.s);
  return isFinite(v) ? Math.round(v) + '°' : '';
}
function renderStatus() {
  var m = cur >= 0 ? moods[cur] : null, parts = [];
  if (m) parts.push('<b>' + esc(m.name) + '</b>');
  else if (dataReady && N > 0) parts.push('<em>Tap to choose a mood</em>');
  var t = tempText(); if (t) parts.push('<span>' + esc(t) + '</span>');
  if (m && m.status) parts.push('<span>' + esc(m.status) + '</span>');
  var h = parts.length ? '<span class="sw">' + parts.join('<i class="sep">·</i>') + '</span>' : '';
  if (h === statusHTML) return;      // a sensor reporting decimals every few seconds: nothing to redo
  statusHTML = h;
  statusEl.innerHTML = h;
  fitStatus();
}
var statusHTML = null;
function renderFace() {
  var m = cur >= 0 ? moods[cur] : null;
  if (!isNight) { face.style.setProperty('--fink', m ? Moods.toHex(m.pal.ink) : DEFAULT_INK); face.style.setProperty('--faccent', m ? Moods.toHex(m.pal.accent) : DEFAULT_ACCENT); }
  else { face.style.removeProperty('--fink'); face.style.removeProperty('--faccent'); }
  faceGlyph.innerHTML = m ? Glyphs.svg(m.glyph) : '';
  renderStatus();
  var fd = faceDots.children;
  for (var i = 0; i < fd.length; i++) fd[i].className = i === cur ? 'cur' : '';
}
/* an outside change arrives gently: the face dips, re-renders at the bottom, and the sky crossfades */
function arrive() {
  if (STATIC || view !== 'idle') { renderFace(); easeSkyTo(skyIdx()); return; }
  face.classList.add('leaving');
  easeSkyTo(skyIdx());
  later('arrive', function () { renderFace(); face.classList.remove('leaving'); }, 720);
  armRest();
}

/* ===================== skies ===================== */
var skyOp = [];
function easeSkyTo(k) {
  if (!skies[k]) return;
  skiesEl.classList.add('ease');
  skies.forEach(function (s, j) { s.classList.toggle('top', j === k); s.classList.toggle('drift', j === k); });
  skies[k].classList.add('on');
  skies[k].style.opacity = 1; skyOp[k] = 1;
  function demote() { skies.forEach(function (s, j) { if (j !== k) { s.style.opacity = 0; skyOp[j] = 0; s.classList.remove('on'); } }); }
  if (STATIC || html.classList.contains('boot')) demote(); else later('skyClean', demote, 1900);
}

/* ===================== deck position (rAF: read once, write opacity/transform) ===================== */
var cache = { card: [], dot: [] }, onSet = -1;
function renderPos(force) {
  if (!N) return;
  if (force) { cache = { card: [], dot: [] }; skyOp = []; onSet = -1; }
  var p = Math.max(0, Math.min(N - 1, pos));
  var i = Math.floor(p), f = p - i;
  if (i >= N - 1) { i = N - 1; f = 0; }
  var r = Math.round(p);
  if (onSet !== r) {
    onSet = r;
    for (var j = 0; j <= N; j++) {
      var keep = j < N && (Math.abs(j - r) <= 1 || j === i + 1);
      if (keep) skies[j].classList.add('on'); else skies[j].classList.remove('on');
    }
  }
  if (skyOp[N] !== 0) { skyOp[N] = 0; skies[N].style.opacity = 0; skies[N].classList.remove('top', 'drift'); }
  for (var k = 0; k < N; k++) {
    var o = k === i ? 1 : (k === i + 1 ? f : 0);
    o = Math.round(o * 1000) / 1000;
    if (skyOp[k] !== o) {
      skyOp[k] = o;
      skies[k].style.opacity = o;
      if (o > 0) skies[k].classList.add('on');
    }
    var d = k - p, ad = Math.abs(d);
    var co = Math.max(0, 1 - ad * 1.15);
    var key = co.toFixed(3) + '|' + d.toFixed(3);
    if (cache.card[k] !== key && (ad < 1.6 || force)) {
      cache.card[k] = key;
      cardIn[k].style.opacity = co.toFixed(3);
      cardIn[k].style.transform = 'translate3d(' + (-d * tw * 0.16).toFixed(1) + 'px,0,0)';
    }
    var w = Math.max(0, 1 - ad);
    var dk = w.toFixed(2);
    if (cache.dot[k] !== dk) {
      cache.dot[k] = dk;
      dots[k][0].style.opacity = (1 - w).toFixed(2);
      dots[k][1].style.opacity = w.toFixed(2);
    }
  }
}

var rafPending = false, settleX = 0, lastSL = 0, lastScrollT = 0, lastSnap = -1;
function onFrame() {
  rafPending = false;
  lastSL = track.scrollLeft;            // the one scroll read per frame
  pos = tw ? lastSL / tw : 0;
  renderPos();
  if (Math.abs(lastSL - settleX) > 4) {
    if (hold) cancelHold();
    if (view === 'deck' && !demoRunning) {
      if (timers.ret) clear('ret');      // browsing again after applying
      armIdle();
    }
  }
}
track.addEventListener('scroll', function () {
  lastScrollT = performance.now();
  if (!rafPending) { rafPending = true; requestAnimationFrame(onFrame); }
  later('settle', function () {
    settleX = lastSL;
    if (!dragging && track.classList.contains('free')) track.classList.remove('free');
    var r = Math.round(pos);
    if (view === 'deck' && r !== lastSnap && Math.abs(pos - r) < 0.03) { lastSnap = r; haptic('tick'); }
    checkPending();
  }, 140);
}, { passive: true });

/* ===================== views ===================== */
function resetCards() {
  cards.forEach(function (c, i) {
    c.className = 'card' + (i === cur ? ' is-now' : '');
    Array.prototype.forEach.call(c.querySelectorAll('.t'), function (t) { t.className = 't'; });
  });
  deck.classList.remove('quiet');
  locked = false;
}
function armIdle() { if (view === 'deck' && !DEMO && !STATIC) later('idle', goIdle, TIMING.deckIdleMs); }

function openDeck(idx) {
  clear('ret'); clear('skyClean'); wakeRest();
  if (N === 0) { setView('deck'); armIdle(); return; }
  idx = Math.max(0, Math.min(N - 1, idx | 0));
  stopMarks();
  resetCards();
  skiesEl.classList.remove('ease');
  skies.forEach(function (s) { s.classList.remove('top'); s.classList.remove('drift'); });
  track.classList.remove('free');
  setView('deck');
  measure();
  track.scrollLeft = idx * tw;
  settleX = lastSL = track.scrollLeft;
  pos = idx; lastSnap = idx;
  renderPos(true);
  armIdle();
}

function goIdle(opts) {
  clear('idle'); clear('ret');
  if (hold) cancelHold();
  pending = null;
  stopMarks();
  var wasDeck = view === 'deck';
  if (rebuildPending) { view = 'idle'; refreshMoods('boot'); }
  if (opts && opts.arrive && !wasDeck) arrive();
  else { renderFace(); easeSkyTo(skyIdx()); }
  // someone was just here: if the face turns to night now (Lights Out applied), it starts at the
  // woken level rather than flashing to 0 first
  woken = true;
  setView('idle');
  if (isNight) later('woken', sleepAgain, TIMING.nightWakeMs); else woken = false;
  showFaceUndo();
  armRest();
}

/* ===================== hold to set ===================== */
var hold = null, pending = null, dragging = false, drag = null;
function startHold(idx, id, x, y) {
  if (locked || !cards[idx]) return;
  if (!canSet()) { haptic('error'); return; }     // the prompt already says Reconnecting
  if (!scriptThere(idx)) return;
  var c = cards[idx];
  hold = { idx: idx, id: id, x: x, y: y };
  settleX = track.scrollLeft;
  c.classList.remove('applied', 'bloom-go', 'has-undo', 'failnote');
  void c.offsetWidth;
  c.classList.add('holding');
  haptic('tick');
  hold.t = setTimeout(function () { completeHold(); }, TIMING.holdMs);
}
function cancelHold() {
  if (!hold) return;
  clearTimeout(hold.t);
  if (cards[hold.idx]) cards[hold.idx].classList.remove('holding');
  hold = null;
}
function completeHold() {
  var idx = hold.idx;
  if (cards[idx]) cards[idx].classList.remove('holding');
  hold = null;
  if (!canSet()) { haptic('error'); return; }
  if (!scriptThere(idx)) return;
  apply(idx);
}
/* a card can outlive its script for a moment (a reload while the deck is open is applied when it
   closes): HA would accept the call and do nothing, so do not send it */
function scriptThere(idx) {
  if (store.get(moods[idx].id)) return true;
  haptic('error');
  showCardNote(cards[idx], 'This mood is gone from Home Assistant.');
  return false;
}
/* a press that lands while the snap is still settling is kept and started once the card lands */
function settledIdx() {
  if (!tw || !N) return -1;
  var p = track.scrollLeft / tw, idx = Math.round(p);
  return (Math.abs(p - idx) < 0.03 && performance.now() - lastScrollT > 90) ? idx : -1;
}
function checkPending() {
  clear('pend');
  if (!pending || hold || view !== 'deck') { if (view !== 'deck') pending = null; return; }
  if (locked) { pending = null; return; }
  var idx = settledIdx();
  if (idx >= 0) { var p = pending; pending = null; startHold(idx, p.id, p.x, p.y); return; }
  if (performance.now() - pending.t0 < 2500) later('pend', checkPending, 50); else pending = null;
}

/* ===================== apply, confirm, undo ===================== */
function apply(idx, opts) {
  opts = opts || {};
  var m = moods[idx], c = cards[idx];
  if (!m) return;
  var prevSlug = shownSlug;
  var changed = m.slug !== shownSlug;
  // Undo goes back to the mood we just left; re-setting the mood that is on has nothing to undo
  var undoTo = opts.fromBoot ? haValue('input_text.house_mood_previous') : (changed ? prevSlug : '');
  if (undoTo === m.slug || idxOf(undoTo) < 0) undoTo = '';
  stopMarks();
  shownSlug = m.slug; cur = idx;
  locked = true;
  clear('idle');
  cards.forEach(function (k, i) { k.classList.toggle('is-now', i === idx); k.classList.remove('failnote'); });
  c.classList.add('applied');
  if (!STATIC) { void c.offsetWidth; c.classList.add('bloom-go'); }
  haptic('thump');
  deck.classList.add('quiet');
  renderFace();
  computeNight();

  var els = c.querySelectorAll('.t'), n = m.touches.length;
  var step = n > 1 ? 1600 / (n - 1) : 0;
  var run = pend = lastRun = { idx: idx, slug: m.slug, name: m.name, t0: now(), prevSlug: prevSlug, done: false, landed: m.slug === haValue('input_text.house_mood'),
    items: m.touches.map(function (t, j) { return { el: els[j], touch: t, at: n > 1 ? 400 + j * step : 1200, state: 'wait', timer: 0 }; }) };
  checkMarks();
  later('mkTimeout', function () { marksTimeout(run); }, TIMING.confirmMs);
  // HA accepts a call it then does nothing with (a missing target, a mood file without its begin
  // steps): if house_mood never reaches this mood, put the face back to what the house has
  later('applySettle', function () { settleApply(run); }, TIMING.confirmMs + 500);

  note('call', 'script.turn_on ' + m.id);
  run.acked = false;
  later('ack', function () {
    // no answer at all: the link is half-open. Reconnect at once, also when the card has already
    // gone back to the face (touches that were already on light every mark before any answer).
    // On the card, say so (not "didn't answer" per mark).
    if (run.acked) return;
    note('call-timeout', m.id);
    if (pend === run) applyFailed(run, 'Home Assistant didn\u2019t answer.');
    client.restart();
  }, TIMING.ackMs);
  client.callService('script', 'turn_on', null, { entity_id: m.id }).then(function () {
    run.acked = true;
    note('call-ok', m.id);
  }, function (err) {
    run.acked = true;
    // the link went with the call: nothing heard from HA since, so the store is no answer
    if (err && err.code === 'disconnected') run.lost = true;
    note('call-failed', (err && err.code) + ' ' + m.id);
    if (pend === run) applyFailed(run, err && err.code === 'disconnected' ? 'Lost Home Assistant. Try again.' : 'Home Assistant didn’t take it.');
  });

  hideUndo();
  if (undoTo) {
    undoUntil = now() + TIMING.undoMs; undoSlug = undoTo;
    var u = c.querySelector('.undo');
    u.innerHTML = undoHTML(moods[idxOf(undoTo)].name);
    c.classList.add('has-undo');
    startWick(u.querySelector('.wick'), TIMING.undoMs, STATIC ? 0.62 : 1);
    if (!STATIC) later('undo', hideUndo, TIMING.undoMs);
  }
  scheduleReturn(run, TIMING.returnMs);
  later('unlock', function () { locked = false; }, 2400);
}

function scheduleReturn(run, ms) {
  if (STATIC || DEMO) return;
  later('ret', function () {
    if (pend === run && !run.done) { scheduleReturn(run, 600); return; }   // marks still lighting: stay
    goIdle();
  }, ms);
}

function stopMarks() {
  if (!pend) return;
  pend.items.forEach(function (it) { clearTimeout(it.timer); });
  clear('mkTimeout');
  pend = null;
}
function checkMarks() {
  var run = pend;
  if (!run || run.done) return;
  var t = now(), all = true;
  run.items.forEach(function (it) {
    if (it.state === 'ok' || it.state === 'miss') return;
    var e = store.get(it.touch.entity);
    var match = !!e && String(e.s).toLowerCase() === it.touch.expect;
    if (match) {
      var wait = STATIC ? 0 : run.t0 + it.at - t;
      if (wait <= 0) { it.state = 'ok'; if (it.el) it.el.classList.add('ok'); return; }
      if (!it.timer) it.timer = setTimeout(function () { it.timer = 0; checkMarks(); }, wait + 5);
    } else if (it.timer) { clearTimeout(it.timer); it.timer = 0; }
    all = false;
  });
  if (all) { run.done = true; clear('mkTimeout'); note('marks', 'all lit'); if (timers.ret) { /* returns 1.2 s after the last mark */ later('ret', goIdle, Math.max(1200, run.t0 + TIMING.returnMs - now())); } }
}
function marksTimeout(run) {
  if (pend !== run || run.done) return;
  if (!run.landed && haValue('input_text.house_mood') !== run.slug) { settleApply(run); return; }
  var misses = [];
  run.items.forEach(function (it) {
    if (it.state === 'ok') return;
    it.state = 'miss'; clearTimeout(it.timer);
    if (it.el) it.el.classList.add('miss');
    misses.push(it.touch.label);
  });
  run.done = true;
  note('marks', 'missed ' + misses.join(','));
  if (misses.length) showCardNote(cards[run.idx], joinLabels(misses) + ' didn’t answer');
  if (!STATIC && view === 'deck') later('ret', goIdle, 3500);
}
function joinLabels(a) { return a.length === 1 ? a[0] : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
function showCardNote(c, text) {
  if (!c) return;
  var n = c.querySelector('.note');
  n.firstChild.textContent = text;
  c.classList.add('failnote');
  fitTo(n.firstChild, n.clientWidth);
}
/* the call failed, or Home Assistant refused the mood (e.g. vacation mode): say why, put it back */
function applyFailed(run, text) {
  var c = cards[run.idx];
  run.failed = true;
  if (lastRun === run) clear('applySettle');
  stopMarks();
  haptic('error');
  hideUndo();
  if (c) { c.classList.remove('applied', 'bloom-go'); showCardNote(c, text); }
  shownSlug = haValue('input_text.house_mood');
  cur = idxOf(shownSlug);
  cards.forEach(function (k, i) { k.classList.toggle('is-now', i === cur); });
  deck.classList.remove('quiet');
  locked = false;
  renderFace(); computeNight();
  if (!STATIC) later('ret', goIdle, 5000);
}

/* the hold was accepted but house_mood never reached the mood */
var lastRun = null;
function settleApply(run) {
  if (lastRun !== run || run.landed || run.failed) return;
  // The call was never answered, or the link was lost with it: the store has heard nothing from HA
  // since the call, so its house_mood says nothing about this mood. Putting the face back to it
  // showed the old mood over a mood HA had set (inbound traffic late by 8.5 s). The reconnect's
  // full state goes through onHouseMood, which shows whatever the house has.
  if (!run.acked || run.lost) { note('apply-unheard', run.slug); return; }
  var s = haValue('input_text.house_mood');
  if (s === run.slug || shownSlug !== run.slug) return;
  note('apply-unconfirmed', run.slug + ' (house: ' + (s || '-') + ')');
  var text = 'Home Assistant didn\u2019t set ' + run.name + '.';
  if (pend === run) { applyFailed(run, text); return; }
  run.failed = true;
  haptic('error');
  hideUndo();
  shownSlug = s; cur = idxOf(s);
  cards.forEach(function (k, i) { k.classList.toggle('is-now', i === cur); if (i === run.idx) k.classList.remove('applied', 'bloom-go'); });
  computeNight();
  if (view === 'idle') { arrive(); faceFlash(text); } else showCardNote(cards[run.idx], text);
}

var lastNotice = null;
function onNotice() {
  var v = store.get('input_text.house_mood_notice');
  var s = v ? String(v.s) : '';
  if (lastNotice === null) { lastNotice = s; return; }     // the first value is history, not news
  if (s === lastNotice) return;
  lastNotice = s;
  if (!s || s === 'unknown') return;
  var parts = s.split('|'), slug = cleanSlug(parts[0]), reason = parts.slice(2).join('|').trim() || 'Home Assistant refused it.';
  note('notice', slug + ': ' + reason);
  if (pend && pend.slug === slug && now() - pend.t0 < 15000) applyFailed(pend, reason);
  else if (lastRun && !lastRun.failed && lastRun.slug === slug && shownSlug === slug && now() - lastRun.t0 < 15000) { lastRun.landed = false; settleApply(lastRun); faceFlash(reason); }
  else if (undoPend && undoPend.slug === slug && now() - undoPend.t0 < 15000) revertUndo(undoPend, reason);
}

/* house_mood is the truth, whoever changed it */
function onHouseMood(boot) {
  var e = store.get('input_text.house_mood');
  if (!e) return;
  var s = cleanSlug(e.s);
  if (lastRun && s === lastRun.slug) lastRun.landed = true;
  if (pend && s === pend.slug) { pend.landed = true; if (shownSlug !== s) { shownSlug = s; cur = idxOf(s); } saveCache(); return; }   // our own mood landing
  // HA has not caught up with what we just set (mood_begin writes previous first, then current)
  if (pend && !pend.landed && s === pend.prevSlug && now() - pend.t0 < 10000) return;
  if (undoPend && s === undoPend.from && now() - undoPend.t0 < 10000) return;
  if (undoPend && s === undoPend.slug) { undoPend = null; clear('undoSettle'); if (shownSlug !== s) { shownSlug = s; cur = idxOf(s); renderFace(); } return; }
  if (s === shownSlug) { if (cur !== idxOf(s)) { cur = idxOf(s); renderFace(); } return; }
  // an outside change: voice, the other phone, an automation (or the first value we hear)
  note('outside', (shownSlug || '-') + ' -> ' + (s || '-'));
  saveCache();
  var hadFace = !!shownSlug || boot === false;
  shownSlug = s; cur = idxOf(s);
  undoPend = null; clear('undoSettle');
  lastRun = null; clear('applySettle');
  if (pend && !pend.done) { stopMarks(); }
  hideUndo();
  computeNight();
  if (view === 'deck') {
    cards.forEach(function (k, i) { k.classList.toggle('is-now', i === cur); });
    return;
  }
  if (boot && !hadFace) { renderFace(); easeSkyTo(skyIdx()); }
  else arrive();
}

var UNDO_ICON = '<path d="M5.5 6.5h6.2a4.3 4.3 0 0 1 0 8.6H7"/><path d="M8.2 3.6 5.3 6.5l2.9 2.9"/>';
function undoHTML(prevName) {
  return '<svg class="gs" viewBox="0 0 18 18" style="stroke-width:1.3">' + UNDO_ICON + '</svg><span>Undo</span><em>back to ' + esc(prevName) + '</em><i class="wick"></i>';
}
function startWick(el, ms, from) {
  if (!el) return;
  if (!STATIC && html.classList.contains('boot')) { setTimeout(function () { startWick(el, ms - 80, from * (ms - 80) / ms); }, 80); return; }
  el.style.transition = 'none';
  el.style.transform = 'scaleX(' + from + ')';
  if (STATIC) return;
  void el.offsetWidth;
  el.style.transition = 'transform ' + ms + 'ms linear';
  el.style.transform = 'scaleX(0)';
}
function showFaceUndo() {
  var rem = undoUntil - now();
  if (STATIC && undoUntil) rem = 6200;
  var k = idxOf(undoSlug);
  if (rem > 300 && k >= 0) {
    faceUndo.innerHTML = undoHTML(moods[k].name);
    faceUndo.style.setProperty('--uaccent', isNight ? '#4a140b' : (cur >= 0 ? Moods.toHex(moods[cur].pal.accent) : DEFAULT_ACCENT));
    face.classList.add('has-undo');
    startWick(faceUndo.querySelector('.wick'), rem, rem / TIMING.undoMs);
  } else face.classList.remove('has-undo');
}
function hideUndo() {
  undoUntil = 0; clear('undo');
  face.classList.remove('has-undo');
  cards.forEach(function (c) { c.classList.remove('has-undo'); });
}
/* Undo did not happen (refused, ignored, or the call failed): say why and show the house's mood */
function revertUndo(up, text) {
  if (undoPend !== up) return;
  undoPend = null; clear('undoSettle');
  note('undo-failed', text);
  haptic('error');
  shownSlug = haValue('input_text.house_mood') || up.from; cur = idxOf(shownSlug);
  cards.forEach(function (k, i) { k.classList.toggle('is-now', i === cur); });
  computeNight();
  if (view === 'idle') arrive(); else { renderFace(); easeSkyTo(skyIdx()); }
  faceFlash(text);
}
function undo() {
  if (!undoUntil) return;
  if (!canSet()) { haptic('error'); return; }
  var back = undoSlug, from = shownSlug;
  hideUndo();
  stopMarks();
  lastRun = null; clear('applySettle');
  undoPend = { slug: back, from: from, t0: now() };
  shownSlug = back; cur = idxOf(back);
  haptic('tick');
  note('call', 'script.turn_on script.mood_undo');
  var up = undoPend, acked = false;
  later('undoAck', function () { if (!acked && undoPend === up) { note('call-timeout', 'script.mood_undo'); revertUndo(up, 'Home Assistant didn\u2019t answer.'); client.restart(); } }, TIMING.ackMs);
  // script.turn_on on mood_undo always succeeds, even when HA then does nothing (no previous
  // mood, or mood_begin refused it): if house_mood has not come back by now, show what it has
  later('undoSettle', function () { if (undoPend === up && haValue('input_text.house_mood') !== up.slug) revertUndo(up, 'Undo didn\u2019t go through.'); else if (undoPend === up) undoPend = null; }, TIMING.confirmMs);
  client.callService('script', 'turn_on', null, { entity_id: 'script.mood_undo' }).then(function () { acked = true; note('call-ok', 'script.mood_undo'); }, function (err) {
    acked = true;
    note('call-failed', (err && err.code) + ' script.mood_undo');
    revertUndo(up, err && err.code === 'disconnected' ? 'Lost Home Assistant. Try again.' : 'Home Assistant didn\u2019t take it.');
  });
  computeNight();
  if (view === 'deck') goIdle(); else arrive();
}

/* ===================== input ===================== */
/* Escape hatch: five taps on the clock within 3 s, each less than 0.4 s after the last. A tap on the
   clock opens the deck at once (it is where most people tap); taps that follow quickly enough on
   the same band of the screen, now over the deck, still count, and are kept from the deck. */
var clockTaps = [], clockBand = null, escapeAt = 0;
function clockTap(open) {
  var t = now();
  if (clockTaps.length && t - clockTaps[clockTaps.length - 1] > TIMING.clockTapGapMs) clockTaps = [];
  clockTaps.push(t);
  while (clockTaps.length && t - clockTaps[0] > TIMING.clockTapWindowMs) clockTaps.shift();
  if (clockTaps.length >= 5) {
    clockTaps = [];
    escapeAt = t;
    note('openSettings', true);
    if (view === 'deck') goIdle();
    shellCall('openSettings');
    return;
  }
  if (open && view === 'idle' && N > 0) openDeck(Math.max(0, cur));
}
document.addEventListener('pointerdown', function (e) {
  if (view !== 'deck' || !clockTaps.length || !clockBand) return;
  if (now() - clockTaps[clockTaps.length - 1] > TIMING.clockTapGapMs) { clockTaps = []; return; }
  if (e.clientY < clockBand.top || e.clientY > clockBand.bottom) return;
  e.stopPropagation(); e.preventDefault();
  clockTap(false);
}, true);
/* On the phone the fifth tap's click arrives after its pointerdown has already sent the deck back
   to the face, so it lands on the clock and would open the deck again behind Settings: drop it. */
document.addEventListener('click', function (e) {
  if (escapeAt && now() - escapeAt < 700) { e.stopPropagation(); e.preventDefault(); }
}, true);
document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
document.addEventListener('pointerdown', function () { if (view === 'deck' && isNight) wakeNight(); }, true);
face.addEventListener('pointerdown', function () { wakeRest(); });
face.addEventListener('click', function (e) {
  if (view !== 'idle') return;
  var tgt = e.target;
  if (tgt.closest && tgt.closest('.undo')) { e.stopPropagation(); if (isNight) wakeNight(); undo(); return; }
  if (tgt.closest && tgt.closest('.clock')) {
    var asleep = isNight && !woken, r = clockEl.getBoundingClientRect();
    clockBand = { top: r.top, bottom: r.bottom };
    wakeNight(); clockTap(!asleep); return;
  }
  if (isNight && !woken) { wakeNight(); return; }     // at night the first touch only lights the face
  if (isNight) wakeNight();
  if (N > 0) openDeck(Math.max(0, cur));
});
deck.addEventListener('click', function (e) {
  if (e.target.closest && e.target.closest('.undo')) { e.stopPropagation(); undo(); }
});
tbTime.addEventListener('click', function () { if (view === 'deck') goIdle(); });
$('backBtn').addEventListener('click', function () { if (view === 'deck') goIdle(); });

track.addEventListener('pointerdown', function (e) {
  if (view !== 'deck' || demoRunning) return;
  armIdle();
  if (e.target.closest && e.target.closest('.undo')) return;
  if (e.pointerType === 'mouse') {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, sl: track.scrollLeft, moved: false };
    try { track.setPointerCapture(e.pointerId); } catch (err) {}
  }
  var idx = settledIdx();
  if (idx >= 0) startHold(idx, e.pointerId, e.clientX, e.clientY);
  else if (!locked) { pending = { id: e.pointerId, x: e.clientX, y: e.clientY, t0: performance.now() }; later('pend', checkPending, 50); }
});
track.addEventListener('pointermove', function (e) {
  if (hold && hold.id === e.pointerId) {
    var dx = e.clientX - hold.x, dy = e.clientY - hold.y;
    if (dx * dx + dy * dy > 100) cancelHold();
  }
  if (pending && pending.id === e.pointerId) {
    var px = e.clientX - pending.x, py = e.clientY - pending.y;
    if (px * px + py * py > 100) { pending = null; clear('pend'); }
  }
  if (drag && drag.id === e.pointerId) {
    var mx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(mx) > 6) { drag.moved = true; dragging = true; pending = null; track.classList.add('free'); }
    if (drag.moved) track.scrollLeft = drag.sl - mx;
  }
}, { passive: true });
function endPointer(e) {
  if (hold && hold.id === e.pointerId) cancelHold();
  if (pending && pending.id === e.pointerId) { pending = null; clear('pend'); }
  if (drag && drag.id === e.pointerId) {
    if (drag.moved) {
      var mx = e.clientX - drag.x, base = Math.round(drag.sl / tw);
      var target = base + (mx < -tw * 0.12 ? 1 : mx > tw * 0.12 ? -1 : 0);
      target = Math.max(0, Math.min(N - 1, target));
      track.scrollTo({ left: target * tw, behavior: 'smooth' });
    }
    drag = null; dragging = false;
  }
}
track.addEventListener('pointerup', endPointer);
track.addEventListener('pointercancel', endPointer);
document.addEventListener('keydown', function (e) {
  if (view !== 'deck') { if ((e.key === 'Enter' || e.key === ' ') && N > 0) openDeck(Math.max(0, cur)); return; }
  var idx = Math.round(pos);
  if (e.key === 'ArrowRight') track.scrollTo({ left: Math.min(N - 1, idx + 1) * tw, behavior: 'smooth' });
  if (e.key === 'ArrowLeft') track.scrollTo({ left: Math.max(0, idx - 1) * tw, behavior: 'smooth' });
  if (e.key === 'Escape') goIdle();
  armIdle();
});
window.addEventListener('resize', function () {
  if (window.__fitUnit) window.__fitUnit();
  measure();
  if (view === 'deck' && N) { var idx = Math.round(pos); track.scrollLeft = idx * tw; pos = idx; renderPos(true); }
  fitNames();
});

/* ===================== demo loop (mock mode only) ===================== */
var demoRunning = false;
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function glide(k) { track.scrollTo({ left: k * tw, behavior: 'smooth' }); }
function demo() {
  demoRunning = true;
  var n = 0;
  (function loop() {
    sleep(2500).then(function () {
      if (!N) return loop();
      openDeck(Math.max(0, cur));
      var k = 0;
      function step() {
        if (k < N) { glide(k++); return sleep(1150).then(step); }
        var t = n % N; if (t === cur) t = (t + 1) % N; n++;
        glide(t);
        return sleep(1400).then(function () { locked = false; startHold(t, -1, 0, 0); return sleep(TIMING.holdMs + 4000 + 2400); })
          .then(function () { if (view !== 'idle') goIdle(); loop(); });
      }
      return sleep(1100).then(step);
    });
  })();
}

/* ===================== fps readout ===================== */
function fpsMeter() {
  var el = document.createElement('div'); el.className = 'fps'; el.textContent = '-- fps'; document.body.appendChild(el);
  var samples = [], last = 0, lastUpd = 0;
  function f(t) {
    if (last) samples.push([t, t - last]);
    last = t;
    while (samples.length && samples[0][0] < t - 2000) samples.shift();
    if (t - lastUpd > 400 && samples.length > 2) {
      lastUpd = t;
      var sum = 0, worst = 0;
      for (var i = 0; i < samples.length; i++) { sum += samples[i][1]; if (samples[i][1] > worst) worst = samples[i][1]; }
      el.textContent = (1000 / (sum / samples.length)).toFixed(0) + ' fps\nworst ' + worst.toFixed(0) + ' ms';
    }
    requestAnimationFrame(f);
  }
  requestAnimationFrame(f);
}

/* ===================== boot ===================== */
var booted = false;
function bootReady() {
  if (booted) return;
  booted = true;
  var mq = Q.get('mood'), at = Math.max(0, cur);
  if (MODE !== 'mock' && mq != null) { at = /^\d+$/.test(mq) ? +mq : Math.max(0, idxOf(mq)); }
  if (START === 'deck') openDeck(at);
  else if (START === 'applied') {
    openDeck(at);
    // only the mock house is changed by a test parameter; a real one just shows the deck
    if (MODE === 'mock' && N) apply(Math.max(0, cur), { fromBoot: true });
  }
  if (DEMO) demo();
}

measure();
tick();
build();
loadCache();
renderFace();
setView('idle');
easeSkyTo(skyIdx());
skiesEl.classList.remove('ease');
armRest();
renderHealth();
startClient();
renderOffline();
__shellQueue.splice(0).forEach(function (ev) { window.__onShell(ev[0], ev[1]); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitNames);
requestAnimationFrame(function () { requestAnimationFrame(function () { html.classList.remove('boot'); }); });
if (FPS) fpsMeter();
updateBrightness(true);
window.__moodsBooted = true;

window.__moods = {
  info: function () {
    return { mode: MODE, view: view, status: client ? client.status() : 'none', dataReady: dataReady, shown: shownSlug, ha: haValue('input_text.house_mood'),
      previous: haValue('input_text.house_mood_previous'), moods: moods.map(function (m) { return m.slug; }), cur: cur, night: isNight, woken: woken,
      brightness: lastB, undo: undoUntil ? Math.max(0, undoUntil - now()) : 0, undoTo: undoSlug, offline: html.classList.contains('offline'),
      marks: pend ? pend.items.map(function (i) { return i.touch.label + ':' + i.state; }) : null,
      cardNote: (function () { for (var k = 0; k < cards.length; k++) if (cards[k].classList.contains('failnote')) return cards[k].querySelector('.note').textContent; return ''; })(),
      faceNote: faceNote.classList.contains('on') ? faceNote.textContent : '', status_line: statusEl.textContent, health: healthEl.textContent, lux: lux,
      settings: panelSettings(), settingIds: [SET.night, SET.screen] };
  },
  trail: trail,
  sim: function () { return sim; }
};
})();
