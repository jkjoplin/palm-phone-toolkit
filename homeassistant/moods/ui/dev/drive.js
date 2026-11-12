#!/usr/bin/env node
/* End-to-end run of the UI against the fake Home Assistant, over DevTools, in real time.
   It starts its own fake-ha.js (port 8767 unless FAKE_PORT), loads the page in SHELL mode with a
   stand-in window.Shell (it records every bridge call and serves a config pointing at the fake),
   and walks through: apply + marks, undo, a mark that never answers, a refusal (vacation mode),
   a mood's time window (Good Morning, 05:00-11:00, on the fake's pinned clock: refused, accepted,
   and an Undo into it refused once the window has closed), an outside change, a dropped connection, a stalled (half-open) connection, shell events
   (power, net, sensor), the night face, and the five-tap escape hatch.
   Then it prints the service calls the fake received and a PASS/FAIL line per check.

   usage: node ui/dev/drive.js [page_url] [shot_dir]
     page_url  default http://127.0.0.1:8766/index.html
     shot_dir  default ui/dev/shots (git-ignored); files are named ui-fake-*.png
   SKIP_STALL=1 skips the 45 s half-open socket check; SKIP_LUX=1 skips the 40 s dark-room check.
   The fake's house clock is pinned (--clock 21:18, then /control/clock), so the window checks give
   the same result at any time of day; mock mode's house follows the page's ?time=. */
'use strict';
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { launch, sleep } = require('./cdp');

const PAGE = process.argv[2] || 'http://127.0.0.1:8766/index.html';
const SHOTS = process.argv[3] || path.join(__dirname, 'shots');
const SUFFIX = process.env.DRIVE_W ? '-' + process.env.DRIVE_W : '';
const PFX = process.env.SHOT_PREFIX || 'ui-fake';
const fs = require('fs');
const os = require('os');
const FAKE_PORT = +(process.env.FAKE_PORT || 8767);
const TOKEN = 'test-token-not-real';

function ctl(p) {
  return new Promise((res, rej) => http.get('http://127.0.0.1:' + FAKE_PORT + p, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(b); } }); }).on('error', rej));
}

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  -- ' + detail : '')); }

const SHELL = (cfg) => `
  (function () {
    var calls = [];
    window.__shellCalls = calls;
    function rec(n, a) { calls.push({ t: Date.now(), n: n, a: a }); }
    window.Shell = {
      getConfig: function () { rec('getConfig', []); return ${JSON.stringify(JSON.stringify(cfg))}; },
      setBrightness: function (v) { rec('setBrightness', [v]); },
      haptic: function (k) { rec('haptic', [k]); },
      heartbeat: function () { rec('heartbeat', []); },
      openSettings: function () { rec('openSettings', []); },
      reload: function () { rec('reload', []); },
      log: function (l, m) { rec('log', [l, m]); }
    };
  })();`;

(async () => {
  // the window rule itself (sim.js mirrors mood_begin's template): boundaries, midnight, bad windows
  {
    const HouseSim = require('../sim.js');
    const W = (w, h, m) => { const d = new Date(); d.setHours(h || 0, m || 0, 0, 0); return HouseSim.windowState(w, d).state; };
    const gm = { from: '05:00', to: '11:00' }, wrap = { from: '22:00', to: '02:00' };
    const got = [W(gm, 4, 59), W(gm, 5, 0), W(gm, 10, 59), W(gm, 11, 0), W(wrap, 23, 30), W(wrap, 1, 59), W(wrap, 2, 0), W(wrap, 21, 59),
      W(null), W({ from: '05:00', to: 660 }), W({ from: '08:00', to: '08:00' }), W('morning'), W({ from: '5:00', to: '11:00' }), W({ from: '05:00' })].join();
    check('window rule: 04:59 out, 05:00 in, 10:59 in, 11:00 out; 22:00-02:00 crosses midnight; none; malformed is "bad" (runs)', got === 'out,in,in,out,in,in,out,out,none,bad,bad,bad,bad,bad', got);
    // mode: restart, as in HA: Good Morning started at 10:59 and tapped again at 11:00 is refused,
    // and the re-tap has already stopped the earlier run (its lamp never comes on; house_mood stays)
    let at = [10, 59];
    const sim = new HouseSim({ initial: 'focus', clock: () => { const d = new Date(); d.setHours(at[0], at[1], 0, 0); return d; },
      moods: [{ entity_id: 'script.mood_good_morning', alias: 'Mood: Good Morning', attributes: { mood: true, mood_name: 'Good Morning',
        mood_window: { from: '05:00', to: '11:00' }, mood_touches: [{ label: 'Lights', entity: 'light.role_bedroom_lamps', expect: 'on' }] } }] });
    sim.runMood('script.mood_good_morning', 'tap');
    await sleep(450);
    const s1 = sim.states['input_text.house_mood'].state;
    at = [11, 0];
    sim.runMood('script.mood_good_morning', 'tap');
    await sleep(2600);
    const S = (id) => sim.states[id].state;
    check('a re-tap of a still-running Good Morning after 11:00 is refused and stops the earlier run (mode: restart)',
      s1 === 'good_morning' && S('input_text.house_mood') === 'good_morning' && S('script.mood_good_morning') === 'off'
        && S('light.role_bedroom_lamps') === 'off' && /\|Good Morning only runs between 05:00 and 11:00\.$/.test(S('input_text.house_mood_notice')),
      [s1, S('input_text.house_mood'), S('script.mood_good_morning'), S('light.role_bedroom_lamps'), S('input_text.house_mood_notice')].join(' / '));
  }
  const fake = spawn(process.execPath, [path.join(__dirname, 'fake-ha.js'), '--port', String(FAKE_PORT), '--token', TOKEN, '--never', 'light.role_patio_lights', '--initial', 'wind_down', '--previous', 'lights_out', '--clock', '21:18', '--quiet'], { stdio: 'inherit' });
  await sleep(800);
  const b = await launch();
  try {
    const W = +(process.env.DRIVE_W || 360), H = +(process.env.DRIVE_H || 640);
    const p = await b.page(W, H);
    const cfg = { mock: false, haUrl: 'ws://127.0.0.1:' + FAKE_PORT + '/api/websocket', token: TOKEN, panel: 'bedroom', deviceName: 'palm-test', nightStart: '23:59', nightEnd: '23:59', tempEntity: 'sensor.bedroom_temperature', appVersion: '0.1.0' };
    await p.inject(SHELL(cfg));
    const info = () => p.eval('JSON.stringify(window.__moods.info())').then(JSON.parse);
    const shellCalls = (n) => p.eval('JSON.stringify(window.__shellCalls' + (n ? '.filter(function(c){return c.n===' + JSON.stringify(n) + '})' : '') + ')').then(JSON.parse);
    async function until(fn, ms, step = 100) { const t0 = Date.now(); for (;;) { const i = await info(); if (fn(i)) return i; if (Date.now() - t0 > ms) return i; await sleep(step); } }
    const u = Math.min(W / 360, H / 640), CX = W / 2;   // 1u in CSS px; cards are centred
    const tStart = Date.now();

    await p.go(PAGE + '?time=21:18', 500);
    let i = await until((x) => x.status === 'ready' && x.dataReady, 8000);
    check('connects in shell mode and authenticates', i.mode === 'shell' && i.status === 'ready', i.mode + '/' + i.status);
    check('moods come from the parsed package: all 9, this panel first, then by order', i.moods.join() === 'wind_down,movie_night,afterglow,lights_out,good_morning,focus,hosting,away,showcase', i.moods.join(','));
    check('current mood follows input_text.house_mood', i.shown === 'wind_down' && i.ha === 'wind_down', i.shown);
    check('status line from live data', /Wind Down.*68°.*Diffuser on/.test(i.status_line), i.status_line);
    const hb0 = await shellCalls('heartbeat');
    check('heartbeat sent at start', hb0.length >= 1, hb0.length + ' so far');
    const leak = (await p.eval('JSON.stringify([document.documentElement.outerHTML.indexOf(' + JSON.stringify(TOKEN) + '), JSON.stringify(window.__moods.info()).indexOf(' + JSON.stringify(TOKEN) + '), JSON.stringify(window.__moods.trail).indexOf(' + JSON.stringify(TOKEN) + ')])'));
    check('token not in the DOM or the debug trail', leak === '[-1,-1,-1]', leak);
    await p.shot(path.join(SHOTS, PFX + SUFFIX + '-idle.png'));

    // ---- open the deck, go to Movie Night, hold to set
    await ctl('/control/calls?clear=1');
    await p.tap(CX, 470 * u);
    i = await until((x) => x.view === 'deck', 2000);
    check('tap on the face opens the deck', i.view === 'deck', i.view);
    await sleep(700);
    await p.key('ArrowRight');
    await sleep(1200);
    await p.press(CX, 485 * u, 300);   // too short: must not set anything
    await sleep(400);
    let calls = await ctl('/control/calls');
    check('a 300 ms press does not change the house', calls.length === 0, JSON.stringify(calls.map((c) => c.service)));
    await p.press(CX, 485 * u, 800);
    await sleep(300);
    calls = await ctl('/control/calls');
    check('a completed hold calls script.turn_on on the mood entity', calls.length === 1 && calls[0].service === 'turn_on' && calls[0].entity_id[0] === 'script.mood_movie_night', JSON.stringify(calls.map((c) => c.domain + '.' + c.service + ' ' + c.entity_id)));
    i = await until((x) => x.marks && x.marks.every((m) => /:ok$/.test(m)), 6000);
    check('marks light when the role entities report their state', i.marks && i.marks.every((m) => /:ok$/.test(m)), JSON.stringify(i.marks));
    check('Undo offered, back to the previous mood', i.undo > 0 && i.undoTo === 'wind_down', i.undo + ' ms, ' + i.undoTo);
    await p.shot(path.join(SHOTS, PFX + SUFFIX + '-applied.png'));
    const hap = (await shellCalls('haptic')).map((c) => c.a[0]);
    check('haptics: snap tick, hold tick, apply thump', hap.indexOf('tick') >= 0 && hap.indexOf('thump') >= 0, hap.join(','));

    // ---- undo on the card
    await ctl('/control/calls?clear=1');
    await p.tap(CX, 592 * u);
    await sleep(400);
    calls = await ctl('/control/calls');
    check('Undo calls script.mood_undo', calls.length === 1 && calls[0].entity_id[0] === 'script.mood_undo', JSON.stringify(calls.map((c) => c.service + ' ' + c.entity_id)));
    i = await until((x) => x.ha === 'wind_down' && x.view === 'idle', 4000);
    check('house back to Wind Down, face shows it', i.ha === 'wind_down' && i.shown === 'wind_down' && i.view === 'idle', i.ha + '/' + i.shown + '/' + i.view);
    const st = await ctl('/control/state');
    check('fake HA agrees (mood_undo re-ran the previous mood)', st.mood === 'wind_down' && st.previous === 'movie_night', st.mood + ' prev ' + st.previous);

    // ---- a mark that never answers (Afterglow's patio)
    await sleep(600);
    await p.tap(CX, 470 * u);
    await sleep(900);
    await p.key('ArrowRight'); await sleep(900); await p.key('ArrowRight'); await sleep(1300);
    i = await info();
    await ctl('/control/calls?clear=1');
    await p.press(CX, 485 * u, 800);
    await sleep(3000);
    i = await info();
    check('before 8 s the silent mark is still waiting', i.marks && i.marks.join() === 'Loft:ok,Patio:wait', JSON.stringify(i.marks));
    i = await until((x) => x.marks && x.marks.indexOf('Patio:miss') >= 0, 7000);
    check('after 8 s it stays hollow with the note', i.marks && i.marks.join() === 'Loft:ok,Patio:miss' && /Patio didn.t answer/.test(i.cardNote), JSON.stringify(i.marks) + ' "' + i.cardNote + '"');
    await p.shot(path.join(SHOTS, PFX + SUFFIX + '-miss.png'));
    i = await until((x) => x.view === 'idle', 6000);
    check('returns to the idle face after the note', i.view === 'idle', i.view);
    // face undo still burning? (applied at ~t, miss at 8 s, back at ~11.5 s: the 10 s Undo is over)
    check('Undo gone after 10 s', i.undo === 0, String(i.undo));

    // ---- vacation mode: refused, with the reason
    await ctl('/control/vacation?on=1');
    await p.tap(CX, 470 * u); await sleep(900);
    for (let k = 0; k < 4; k++) { await p.key('ArrowRight'); await sleep(700); }
    await sleep(700);
    const before = (await info()).ha;
    await p.press(CX, 485 * u, 800);
    i = await until((x) => /Vacation/.test(x.cardNote), 4000);
    await sleep(1300);
    check('a refused mood says why and is not shown as current', /Vacation mode is on/.test(i.cardNote) && i.shown === before, '"' + i.cardNote + '" shown=' + i.shown);
    const hapE = (await shellCalls('haptic')).map((c) => c.a[0]);
    check('error haptic on refusal', hapE.indexOf('error') >= 0, hapE.slice(-3).join(','));
    await p.shot(path.join(SHOTS, PFX + SUFFIX + '-refused.png'));
    await ctl('/control/vacation?on=0');
    await p.key('Escape');
    await sleep(1500);

    // ---- Undo that HA refuses: vacation on, Away (allowed) applied, Undo back to a mood mood_begin refuses
    {
      i = await until((x) => x.view === 'idle', 4000);
      const from = i.shown;
      await ctl('/control/vacation?on=1');
      await p.tap(CX, 470 * u); await sleep(900);
      const ia = (await info()).moods.indexOf('away'), at = Math.max(0, (await info()).cur);
      for (let k = 0; k < Math.abs(ia - at); k++) { await p.key(ia > at ? 'ArrowRight' : 'ArrowLeft'); await sleep(650); }
      await sleep(900);
      await p.press(CX, 485 * u, 800);
      i = await until((x) => x.ha === 'away', 4000);
      check('vacation: Away still runs', i.ha === 'away' && i.shown === 'away' && i.undoTo === from, i.ha + '/' + i.shown + ' undo to ' + i.undoTo);
      const h0 = (await shellCalls('haptic')).length;
      await p.tap(CX, 592 * u);
      i = await until((x) => /Vacation/.test(x.faceNote), 4000);
      await sleep(800);
      i = await info();
      check('an Undo HA refuses: the face goes back to the mood the house has, with the reason', i.shown === 'away' && i.ha === 'away' && /Vacation mode is on/.test(i.faceNote) && /Away/.test(i.status_line), i.shown + ' / "' + i.status_line + '" / "' + i.faceNote + '"');
      const hu = (await shellCalls('haptic')).slice(h0).map((c) => c.a[0]);
      check('...with the error haptic', hu.indexOf('error') >= 0, hu.join(','));
      await p.shot(path.join(SHOTS, PFX + SUFFIX + '-undo-refused.png'));
      await ctl('/control/vacation?on=0');

      // Undo that HA ignores: mood_undo finds no previous mood (house_mood_previous is empty)
      await sleep(600);
      await p.tap(CX, 470 * u); await sleep(900);
      await p.key('ArrowLeft'); await sleep(900);
      await p.press(CX, 485 * u, 800);
      i = await until((x) => x.undo > 0 && x.ha === x.shown && x.ha !== 'away', 4000);
      const set = i.shown;
      await ctl('/control/set?entity=input_text.house_mood_previous&state=');
      await p.tap(CX, 592 * u);
      await sleep(1000);
      i = await info();
      check('...an ignored Undo first shows the mood it asked for', i.shown === 'away' && i.ha === set, 'shown ' + i.shown + ' ha ' + i.ha);
      i = await until((x) => x.shown === set, 10000, 200);
      check('...and goes back to the house\'s mood when HA never moves', i.shown === set && /Undo didn.t go through/.test(i.faceNote), i.shown + ' "' + i.faceNote + '"');
      await sleep(900);
    }

    // ---- an apply HA accepts and then does nothing with (a mood file without its begin steps)
    {
      i = await until((x) => x.view === 'idle', 4000);
      const from = i.shown;
      await ctl('/control/noop?entity=script.mood_focus&on=1');
      await ctl('/control/calls?clear=1');
      await p.tap(CX, 470 * u); await sleep(900);
      const fi = (await info()).moods.indexOf('focus'), at = Math.max(0, (await info()).cur);
      for (let k = 0; k < Math.abs(fi - at); k++) { await p.key(fi > at ? 'ArrowRight' : 'ArrowLeft'); await sleep(650); }
      await sleep(900);
      await p.press(CX, 485 * u, 800);
      await sleep(1500);
      const calls2 = await ctl('/control/calls');
      i = await info();
      check('a no-op mood: the call succeeds and the face first shows it', calls2.some((c) => c.entity_id[0] === 'script.mood_focus') && i.shown === 'focus' && i.ha === from, i.shown + ' ha ' + i.ha);
      i = await until((x) => x.shown === from, 12000, 200);
      check('...house_mood never moves, so the face goes back to the house\'s mood and says so', i.shown === from && i.ha === from && /didn.t set Focus/.test(i.cardNote + i.faceNote), i.shown + ' "' + i.cardNote + '" "' + i.faceNote + '"');
      await p.shot(path.join(SHOTS, PFX + SUFFIX + '-noop.png'));
      await ctl('/control/noop?entity=script.mood_focus&on=0');
      await until((x) => x.view === 'idle', 8000);
      await sleep(600);
    }

    // ---- a mood with a time window: Good Morning runs only from 05:00 to 11:00 (the fake's clock)
    {
      const GM = 'Good Morning only runs between 05:00 and 11:00.';
      async function deckTo(slug) {
        await p.tap(CX, 470 * u); await sleep(900);
        const x = await info(), idx = x.moods.indexOf(slug), at = Math.max(0, x.cur);
        for (let k = 0; k < Math.abs(idx - at); k++) { await p.key(idx > at ? 'ArrowRight' : 'ArrowLeft'); await sleep(650); }
        await sleep(900);
      }
      const haps = async (n0) => (await shellCalls('haptic')).slice(n0).map((c) => c.a[0]);
      i = await until((x) => x.view === 'idle', 4000);
      const from = i.shown, st0 = await ctl('/control/state');
      await ctl('/control/clock?at=21:18');
      // vacation stays first: both apply, vacation is the reason given
      await ctl('/control/vacation?on=1');
      await deckTo('good_morning');
      await p.press(CX, 485 * u, 800);
      i = await until((x) => /Vacation|only runs/.test(x.cardNote), 4000);
      check('vacation is still checked first (vacation on, Good Morning outside its window)', /^Vacation mode is on/.test(i.cardNote), '"' + i.cardNote + '"');
      await ctl('/control/vacation?on=0');
      await p.key('Escape'); await sleep(1500);
      // outside the window: refused like vacation mode, nothing written
      await until((x) => x.view === 'idle', 4000);
      let h0 = (await shellCalls('haptic')).length;
      await deckTo('good_morning');
      await p.press(CX, 485 * u, 800);
      i = await until((x) => /only runs/.test(x.cardNote), 4000);
      await sleep(1300);
      i = await info();
      let st = await ctl('/control/state');
      check('outside its window (21:18) Good Morning is refused with the reason, and not shown as current', i.cardNote === GM && i.shown === from && i.ha === from, '"' + i.cardNote + '" shown=' + i.shown);
      check('...nothing written: house_mood and previous unchanged, the notice is "good_morning|<time>|<reason>"', st.mood === st0.mood && st.previous === st0.previous && /^good_morning\|\d{4}-\d\d-\d\dT[^|]+\|/.test(st.notice) && st.notice.endsWith('|' + GM), st.mood + ' prev ' + st.previous + ' notice ' + st.notice);
      let hw = await haps(h0);
      check('...with the error haptic', hw.indexOf('error') >= 0, hw.join(','));
      await p.shot(path.join(SHOTS, PFX + SUFFIX + '-window-refused.png'));
      await p.key('Escape'); await sleep(1500);
      // inside the window: it runs
      await until((x) => x.view === 'idle', 4000);
      await ctl('/control/clock?at=07:30');
      await deckTo('good_morning');
      await p.press(CX, 485 * u, 800);
      i = await until((x) => x.ha === 'good_morning' && x.shown === 'good_morning', 4000);
      st = await ctl('/control/state');
      check('inside its window (07:30) Good Morning runs, and the notice clears', i.ha === 'good_morning' && i.shown === 'good_morning' && st.mood === 'good_morning' && st.previous === from && st.notice === '', i.ha + '/' + i.shown + ' prev ' + st.previous + ' notice "' + st.notice + '"');
      await until((x) => x.view === 'idle', 9000);
      await sleep(600);
      // Undo into it after the window has closed (11:00 is outside: the end is exclusive)
      await deckTo('wind_down');
      await p.press(CX, 485 * u, 800);
      i = await until((x) => x.undo > 0 && x.ha === 'wind_down', 5000);
      const undoTo = i.undoTo;
      await ctl('/control/clock?at=11:00');
      h0 = (await shellCalls('haptic')).length;
      await p.tap(CX, 592 * u);
      i = await until((x) => /only runs/.test(x.faceNote), 5000);
      await sleep(800);
      i = await info();
      st = await ctl('/control/state');
      check('an Undo into Good Morning at 11:00 is refused: the face keeps Wind Down and gives the reason', undoTo === 'good_morning' && i.shown === 'wind_down' && i.ha === 'wind_down' && i.faceNote === GM && st.mood === 'wind_down' && st.previous === 'good_morning', 'undo to ' + undoTo + ', ' + i.shown + ' "' + i.faceNote + '" house ' + st.mood + ' prev ' + st.previous);
      hw = await haps(h0);
      check('...with the error haptic', hw.indexOf('error') >= 0, hw.join(','));
      await ctl('/control/clock?at=21:18');
      await until((x) => x.view === 'idle', 6000);
      await sleep(900);
    }

    // ---- a mood HA sets while what it sends back is late (the phone's Wi-Fi holding inbound packets
    // for 10 s): the call reaches HA at once and the house changes. Focus's one touch is already on, so
    // every mark lights at once and the card is back on the face at 4 s, before any answer. The face
    // used to go back to the old mood at 8.5 s, from a store that had heard nothing since the call,
    // with "Home Assistant didn't set Focus." (reported on a phone as Showcase, Movie Night, Showcase).
    {
      i = await until((x) => x.view === 'idle', 4000);
      const from = i.shown;
      await ctl('/control/set?entity=light.role_office_lights&state=on');
      await p.tap(CX, 470 * u); await sleep(900);
      const fi = (await info()).moods.indexOf('focus'), at = Math.max(0, (await info()).cur);
      for (let k = 0; k < Math.abs(fi - at); k++) { await p.key(fi > at ? 'ArrowRight' : 'ArrowLeft'); await sleep(650); }
      await sleep(900);
      await ctl('/control/lag?ms=10000&for=2500');
      await p.press(CX, 485 * u, 800);
      const t0 = Date.now(), seen = new Set(), notes = new Set();
      while (Date.now() - t0 < 14000) {
        const x = await info();
        if (Date.now() - t0 > 1000) seen.add(x.shown);
        if (x.faceNote || x.cardNote) notes.add(x.faceNote + ' ' + x.cardNote);
        await sleep(150);
      }
      i = await info();
      const st = await ctl('/control/state');
      check('a mood HA set while its answer is 10 s late: the face ends on it, and never says "didn\'t set"', st.mood === 'focus' && i.ha === 'focus' && i.shown === 'focus' && /Focus/.test(i.status_line) && ![...notes].some((n) => /didn.t set/.test(n)),
        'house ' + st.mood + ', shown ' + i.shown + ' "' + i.status_line + '", notes ' + JSON.stringify([...notes]));
      check('...and the face never goes back to the mood before it (' + from + ') meanwhile', !seen.has(from), 'shown: ' + [...seen].join(','));
      // the next check sets Focus from outside: leave the house on another mood
      await ctl('/control/outside?slug=' + from);
      await until((x) => x.shown === from && x.view === 'idle', 4000);
      await sleep(1200);
    }

    // ---- outside change while idle: gentle arrival
    i = await info();
    check('idle again', i.view === 'idle', i.view);
    await ctl('/control/outside?slug=focus');
    let sawLeaving = false;
    for (let k = 0; k < 20; k++) { const l = await p.eval('document.getElementById("face").classList.contains("leaving")'); if (l) sawLeaving = true; await sleep(60); }
    i = await until((x) => x.shown === 'focus', 3000);
    check('an outside change is followed (voice, other phone)', i.shown === 'focus' && /Focus/.test(i.status_line), i.shown + ' / ' + i.status_line);
    check('...with a gentle arrival (face dips, sky crossfades), not a jump', sawLeaving, 'leaving class seen: ' + sawLeaving);
    check('no Undo offered for an outside change', i.undo === 0, String(i.undo));
    await sleep(1200);
    await p.shot(path.join(SHOTS, PFX + SUFFIX + '-outside.png'));

    // ---- dropped connection: Reconnecting, hold disabled, backoff, recovery
    await ctl('/control/refuse?ms=9000');
    await ctl('/control/drop');
    i = await until((x) => x.status !== 'ready', 2000, 50);
    check('drop noticed', i.status !== 'ready' && i.offline, i.status + ' offline=' + i.offline);
    await ctl('/control/outside?slug=hosting');       // changes while the phone is away
    await p.tap(CX, 470 * u); await sleep(900);
    await ctl('/control/calls?clear=1');
    await p.press(CX, 485 * u, 800);
    calls = await ctl('/control/calls');
    const p3 = await p.eval('(function(){var c=document.querySelector(".card .p3");return c?c.textContent+"|"+getComputedStyle(c).opacity:""})()');
    check('while disconnected, hold-to-set is disabled with a quiet Reconnecting note', calls.length === 0 && /^Reconnecting\|0\.6/.test(p3), 'calls=' + calls.length + ' p3=' + p3);
    await p.shot(path.join(SHOTS, PFX + SUFFIX + '-reconnecting.png'));
    await p.key('Escape');
    await sleep(5200);
    i = await info();
    check('face says Reconnecting after 5 s offline', i.faceNote === 'Reconnecting', '"' + i.faceNote + '"');
    i = await until((x) => x.status === 'ready', 35000, 250);
    check('reconnects with backoff once HA is back', i.status === 'ready' && !i.offline, i.status);
    i = await until((x) => x.shown === 'hosting', 3000);
    check('after reconnecting, the mood set meanwhile is shown', i.shown === 'hosting', i.shown);
    const sc = await ctl('/control/state');
    check('fake HA sees exactly one connection again', sc.connections === 1, String(sc.connections));

    // ---- HA down for 40 s while the shell keeps sending RSSI-only net events (every 2 s here; the
    // shell sends them at most every 10 s): the backoff must still build up (1, 2, 4, 8, 16 s ...)
    {
      const n0 = await p.eval('window.__moods.trail.filter(function(e){return e.kind==="status"&&e.detail==="connecting"}).length');
      await ctl('/control/refuse?ms=40000');
      await ctl('/control/drop');
      for (let k = 0; k < 20; k++) { await p.eval('window.__shell("net", {wifi: true, rssi: ' + (-55 - (k % 7)) + '})'); await sleep(2000); }
      const n1 = await p.eval('window.__moods.trail.filter(function(e){return e.kind==="status"&&e.detail==="connecting"}).length');
      check('RSSI-only net events do not defeat the reconnect backoff', n1 - n0 <= 8, (n1 - n0) + ' attempts in 40 s (a retry per event would be about 20)');
      i = await until((x) => x.status === 'ready', 35000, 250);
      check('...and it reconnects once HA is back', i.status === 'ready', i.status);
      // Wi-Fi back after a loss resets the backoff: reconnects at once
      await ctl('/control/drop');
      await p.eval('window.__shell("net", {wifi: false, rssi: null})');
      await sleep(300);
      await p.eval('window.__shell("net", {wifi: true, rssi: -60})');
      i = await until((x) => x.status === 'ready', 3000, 100);
      check('Wi-Fi back reconnects at once', i.status === 'ready', i.status);
    }

    // ---- half-open socket: no pong within 10 s of a ping -> reconnect
    if (!process.env.SKIP_STALL) {
      // only the socket open now goes silent; a new one is a fresh link that HA answers at once, so
      // the not-ready window can be short: look for it in the debug trail, not by polling status
      const lostCount = () => p.eval('window.__moods.trail.filter(function(e){return e.kind==="status"&&e.detail!=="ready"}).length');
      const l0 = await lostCount();
      await ctl('/control/stall?ms=42000');
      const t0 = Date.now();
      let l1 = l0;
      while (Date.now() - t0 < 45000) { l1 = await lostCount(); if (l1 > l0) break; await sleep(250); }
      check('a silent (half-open) socket is dropped by the ping timeout', l1 > l0, 'after ' + Math.round((Date.now() - t0) / 1000) + ' s');
      i = await until((x) => x.status === 'ready', 40000, 500);
      check('...and reconnects', i.status === 'ready', i.status + ' after ' + Math.round((Date.now() - t0) / 1000) + ' s');
    }

    // ---- a hold while the link is half-open: the call gets no answer at all
    if (!process.env.SKIP_STALL) {
      await ctl('/control/calls?clear=1');
      const shownBefore = (await info()).shown;
      await ctl('/control/stall?ms=20000');
      await p.tap(CX, 470 * u); await sleep(900);
      await p.key('ArrowRight'); await sleep(1200);
      const target = (await info()).moods[Math.round(await p.eval('document.getElementById("track").scrollLeft / document.getElementById("track").clientWidth'))];
      await p.press(CX, 485 * u, 800);
      i = await until((x) => /didn.t answer/.test(x.cardNote) && !/Patio|Lights|Loft|TV|Porch|Heat|Bed|Scent/.test(x.cardNote), 8000, 200);
      check('a hold on a half-open link says Home Assistant did not answer (not per-mark misses)', /^Home Assistant didn.t answer\.$/.test(i.cardNote), '"' + i.cardNote + '" marks=' + JSON.stringify(i.marks));
      check('...and the face keeps the mood the house really has', i.shown === shownBefore, 'shown=' + i.shown + ' before=' + shownBefore + ' target=' + target);
      await sleep(1300);
      await p.shot(path.join(SHOTS, PFX + SUFFIX + '-noanswer.png'));
      i = await until((x) => x.status === 'ready', 40000, 500);
      check('...and it reconnects at once (restart), then after the stall', i.status === 'ready', i.status);
      await sleep(1500);
      const late = await ctl('/control/calls');
      check('...and the mood was not run late when the link came back', late.length === 0, JSON.stringify(late.map((c) => c.service + ' ' + c.entity_id)));
      check('...and the house is unchanged', (await ctl('/control/state')).mood === shownBefore, (await ctl('/control/state')).mood);
      await p.key('Escape'); await sleep(1200);
    }

    // ---- a mood added later: script reload, no page reload
    {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-moods-'));
      const src = path.join(__dirname, '..', '..', 'ha', 'packages', 'moods');
      fs.readdirSync(src).forEach((f) => fs.copyFileSync(path.join(src, f), path.join(tmp, f)));
      // the README's add-a-mood path: copy focus.yaml, rename the keys, and (the easy slip) keep the
      // old mood_slug. Scope and touches removed, a glyph the UI does not know, a new palette.
      const focusText = fs.readFileSync(path.join(src, 'focus.yaml'), 'utf8');
      const reading = focusText.replace(/script\.mood_focus:/g, 'script.mood_reading:').replace(/^  mood_focus:/m, '  mood_reading:')
        .replace(/mood_name: Focus/, 'mood_name: Reading').replace(/mood_order: 60/, 'mood_order: 15').replace(/mood_glyph: desk_lamp/, 'mood_glyph: book')
        .replace(/alias: "Mood: Focus"/, 'alias: "Mood: Reading"').replace(/^ {6}mood_scope:.*\n/m, '').replace(/^ {6}mood_panels:.*\n/m, '      mood_panels: [bedroom]\n')
        .replace(/ {6}mood_touches:\n( {8}- .*\n)+/, '')
        .replace(/ {6}mood_palette:\n( {8}.*\n| {10}.*\n)+/, '      mood_palette:\n        base: "#0d0a08"\n        glows: ["#c9a46a", "#5b4636", "#3d5566"]\n        accent: "#e9cf9c"\n');
      if (!/mood_slug: focus/.test(reading) || /mood_touches/.test(reading) || /sky:|#3aa0e6/.test(reading) || !/accent: "#e9cf9c"/.test(reading)) throw new Error('reading.yaml copy went wrong');
      fs.writeFileSync(path.join(tmp, 'reading.yaml'), reading);
      i = await until((x) => x.view === 'idle', 3000);
      const shown0 = i.shown, n0 = i.moods.length;
      let sawChoose = false, sawNeutral = false;
      await ctl('/control/reload?dir=' + encodeURIComponent(tmp));
      for (let k = 0; k < 30; k++) {
        const x = await info();
        if (/Tap to choose/.test(x.status_line) || x.cur < 0) sawChoose = true;
        await sleep(100);
      }
      i = await info();
      check('a mood added by a script reload appears without a page reload (even with a stale mood_slug)', i.moods.length === n0 + 1 && i.moods.indexOf('reading') >= 0 && i.moods.indexOf('focus') >= 0, i.moods.join(','));
      const warned = (await shellCalls('log')).some((c) => /mood_reading has mood_slug "focus"/.test(c.a[1]));
      check('...and the stale mood_slug is logged as a warning', warned, String(warned));
      check('...the current mood stays, with no flash of "Tap to choose a mood"', i.shown === shown0 && !sawChoose, 'shown=' + i.shown + ' flash=' + sawChoose);
      // the new card, through the live path
      await p.tap(CX, 470 * u); await sleep(900);
      const idx = i.moods.indexOf('reading'), from = Math.max(0, i.cur);
      for (let k = 0; k < Math.abs(idx - from); k++) { await p.key(idx > from ? 'ArrowRight' : 'ArrowLeft'); await sleep(650); }
      await sleep(900);
      await p.shot(path.join(SHOTS, PFX + SUFFIX + '-newmood.png'));
      const g = await p.eval('(function(){var c=document.querySelectorAll(".card")[' + idx + '];return c.querySelector(".name").textContent+"|"+c.querySelector(".scope").className+"|"+(c.querySelector(".touches .t")?"touches":"no touches")})()');
      check('...its card is composed from the palette alone (neutral glyph, no scope, no touches)', /^Reading\|scope bare\|no touches$/.test(g), g);
      await p.press(CX, 485 * u, 800);
      i = await until((x) => x.ha === 'reading', 4000);
      check('...and setting it records "reading" (from the entity id), shown as current', i.ha === 'reading' && i.shown === 'reading', 'ha ' + i.ha + ' shown ' + i.shown);
      i = await until((x) => x.view === 'idle', 8000);
      check('...the face shows Reading', /^Reading/.test(i.status_line), '"' + i.status_line + '"');
      await sleep(600);
      await p.tap(CX, 470 * u); await sleep(900);
      // reload the original folder while the deck is open: the deck does not change under the finger
      await ctl('/control/reload');
      await sleep(1500);
      i = await info();
      const cardsNow = await p.eval('document.querySelectorAll(".card").length');
      check('while the deck is open a reload does not rebuild it', cardsNow === n0 + 1 && i.view === 'deck', cardsNow + ' cards, view ' + i.view);
      await p.key('Escape');
      await sleep(1500);
      i = await info();
      check('...back on the face it takes the new list (' + n0 + ' moods)', i.moods.length === n0 && i.moods.indexOf('reading') < 0 && (await p.eval('document.querySelectorAll(".card").length')) === n0, i.moods.length + ' ' + i.moods.join(','));
      await ctl('/control/outside?slug=hosting');
      await until((x) => x.shown === 'hosting', 4000);
      await sleep(1000);
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    // ---- shell events
    await p.eval('window.__shell("power", {level: 80, tempC: 44.5, charging: false, plugged: true})');
    await p.eval('window.__shell("net", {wifi: false, rssi: null})');
    await sleep(300);
    i = await info();
    check('battery above 42 C and lost Wi-Fi show a discreet indicator', /Phone warm/.test(i.health) && /No Wi-Fi/.test(i.health), '"' + i.health + '"');
    await p.shot(path.join(SHOTS, PFX + SUFFIX + '-health.png'));
    console.log('     face at health shot: ' + await p.eval('JSON.stringify([document.getElementById("face").className, document.documentElement.className, document.documentElement.getAttribute("data-view"), getComputedStyle(document.getElementById("face")).opacity, getComputedStyle(document.querySelector(".clock")).opacity, getComputedStyle(document.querySelector(".status")).opacity])'));
    await p.eval('window.__shell("power", {level: 80, tempC: 41, charging: false, plugged: true})');
    await p.eval('window.__shell("net", {wifi: true, rssi: -60})');
    await sleep(300);
    i = await info();
    check('indicator clears (with hysteresis on temperature)', /Phone warm/.test(i.health) && !/No Wi-Fi/.test(i.health), '"' + i.health + '" (41 C is still above the 40 C clear point)');
    await p.eval('window.__shell("power", {level: 80, tempC: 38, charging: false, plugged: true})');
    await sleep(200);
    i = await info();
    check('...and clears below 40 C', i.health === '', '"' + i.health + '"');

    if (!process.env.SKIP_LUX) {
      await p.eval('window.__shell("sensor", {lux: 1.2, near: false})');
      await sleep(31500);
      i = await info();
      check('a dark room (lux < 3 for 30 s) turns the night face on, darkest brightness', i.night && i.brightness === 0, 'night=' + i.night + ' b=' + i.brightness);
      await p.eval('window.__shell("sensor", {lux: 1.2, near: true})');
      await sleep(200);
      i = await info();
      check('a hand near the phone wakes it to the dim interactive level', i.woken && i.brightness === 0.04, 'woken=' + i.woken + ' b=' + i.brightness);
      await p.shot(path.join(SHOTS, PFX + SUFFIX + '-night.png'));
      await p.eval('window.__shell("sensor", {lux: 40, near: false})');
      await sleep(10500);
      i = await info();
      check('light again (lux > 6 for 10 s) leaves night', !i.night, 'night=' + i.night);

      // Lights Out by day in a lit room: the day face (a bedroom phone must not look dead all day)
      await p.eval('window.__shell("sensor", {lux: 400, near: false})');
      await ctl('/control/outside?slug=lights_out');
      i = await until((x) => x.shown === 'lights_out', 4000);
      await sleep(400);
      i = await info();
      check('Lights Out current in a lit room by day: day face, day brightness', i.shown === 'lights_out' && !i.night && i.brightness > 0.1, 'night=' + i.night + ' b=' + i.brightness);
      await p.shot(path.join(SHOTS, PFX + SUFFIX + '-lightsout-day.png'));
      await p.eval('window.__shell("sensor", {lux: 4, near: false})');
      await sleep(400);
      i = await info();
      check('...the lamps go off and the room settles at 4 lux (a streetlight): the Lights Out night face at once', i.night && i.brightness === 0, 'night=' + i.night + ' b=' + i.brightness);
      // the deck opened from that face stays night: on the phone it jumped from 10 to 102 of 255
      {
        const b0 = (await shellCalls('setBrightness')).length;
        await p.tap(CX, 470 * u); await sleep(600);
        const w = await info();
        await p.tap(CX, 470 * u); await sleep(900);
        i = await info();
        const sent = (await shellCalls('setBrightness')).slice(b0).map((c) => c.a[0]);
        check('...a touch wakes it (0.04), and the deck opened from it stays night at that level, no jump to the day deck', w.view === 'idle' && w.woken && w.brightness === 0.04 && i.view === 'deck' && i.night && i.brightness === 0.04 && Math.max.apply(null, sent) <= 0.04, 'woken b=' + w.brightness + ', deck night=' + i.night + ' b=' + i.brightness + ', sent ' + sent.join(','));
        await p.shot(path.join(SHOTS, PFX + SUFFIX + '-lightsout-deck.png'));
        await p.key('Escape'); await sleep(1200);
      }
      await p.eval('window.__shell("sensor", {lux: 40, near: false})');
      await ctl('/control/outside?slug=wind_down');
      await sleep(11000);
      i = await info();
      check('...and back to day after the light dwell', !i.night && i.shown === 'wind_down', 'night=' + i.night + ' ' + i.shown);
    }

    // ---- five taps on the clock: openSettings once, nothing else
    await ctl('/control/calls?clear=1');
    const os0 = (await shellCalls('openSettings')).length;
    for (let k = 0; k < 5; k++) { await p.tap(CX, 250 * u); await sleep(180); }
    await sleep(700);
    i = await info();
    const os1 = (await shellCalls('openSettings')).length;
    check('five taps on the clock call Shell.openSettings exactly once (back on the face)', os1 - os0 === 1 && i.view === 'idle', 'openSettings +' + (os1 - os0) + ', view=' + i.view);
    const calls5 = await ctl('/control/calls');
    check('...and the taps that landed on the deck set nothing', calls5.length === 0, JSON.stringify(calls5.map((c) => c.entity_id)));
    await sleep(600);
    await p.tap(CX, 250 * u);
    await sleep(120);
    i = await info();
    check('a single tap on the clock opens the deck at once', i.view === 'deck', i.view);
    await sleep(700);
    await p.key('Escape');

    // ---- brightness policy and heartbeat cadence
    const br = (await shellCalls('setBrightness')).map((c) => c.a[0]);
    check('brightness: idle dim, deck brighter', br.indexOf(0.18) >= 0 && br.indexOf(0.4) >= 0, Array.from(new Set(br)).join(','));
    const hb = await shellCalls('heartbeat');
    const secs = (Date.now() - tStart) / 1000;
    check('heartbeat every 5 s throughout', hb.length >= Math.floor(secs / 5) - 1, hb.length + ' beats in ' + Math.round(secs) + ' s');
    const logs = (await shellCalls('log')).map((c) => c.a.join(' '));
    check('nothing sent to Shell.log contains the token', logs.every((l) => l.indexOf(TOKEN) < 0), logs.length + ' log lines: ' + logs.join(' | ').slice(0, 200));
    if (p.console.length) console.log('console: ' + p.console.join(' | '));
    check('no exceptions in the page', !p.console.some((l) => /EXCEPTION|error/i.test(l)), p.console.filter((l) => /EXCEPTION|error/i.test(l)).join(' | '));

    // ---- night face from config hours: first touch only wakes, second opens the deck
    await p.inject(SHELL(Object.assign({}, cfg, { nightStart: '22:00', nightEnd: '07:00' })));
    await p.go(PAGE + '?time=02:10', 500);
    i = await until((x) => x.status === 'ready', 8000);
    await sleep(500);
    i = await info();
    check('night hours from config: darkest', i.night && i.brightness === 0, 'night=' + i.night + ' b=' + i.brightness);
    await p.tap(CX, 470 * u); await sleep(600);
    i = await info();
    check('at night the first touch only wakes the face (dim interactive level)', i.view === 'idle' && i.woken && i.brightness === 0.04, i.view + ' b=' + i.brightness);
    await p.tap(CX, 470 * u); await sleep(900);
    i = await info();
    check('...the second opens the night deck', i.view === 'deck' && i.night && i.brightness === 0.04, i.view + ' night=' + i.night + ' b=' + i.brightness);
    await p.shot(path.join(SHOTS, PFX + SUFFIX + '-nightdeck.png'));

    // ---- tempEntity may be a thermostat: its state is the HVAC mode, the temperature an attribute
    await p.inject(SHELL(Object.assign({}, cfg, { tempEntity: 'climate.thermostat' })));
    await p.go(PAGE + '?time=21:18', 500);
    i = await until((x) => x.status === 'ready' && x.dataReady && /71°/.test(x.status_line), 8000);
    check('tempEntity set to a climate entity shows its current_temperature', /71°/.test(i.status_line) && !/heat/.test(i.status_line), i.status_line);
    await ctl('/control/temp?entity=climate.thermostat&value=73.4');
    i = await until((x) => /73°/.test(x.status_line), 4000);
    check('...and follows it when only that attribute changes', /73°/.test(i.status_line), i.status_line);

    // ---- this panel's settings from the Home Assistant "Moods" dashboard (input_select.moods_panel_bedroom_*):
    // applied when readable, the phone's own config (and usual levels) for anything else
    {
      const NIGHT = 'input_select.moods_panel_bedroom_night_hours', SCREEN = 'input_select.moods_panel_bedroom_screen';
      const setH = (id, s) => ctl('/control/set?entity=' + id + '&state=' + encodeURIComponent(s));
      const st0 = await ctl('/control/state');
      check('the fake has the package\'s panel settings at their first option', st0.states[NIGHT] === "This phone's own hours" && st0.states[SCREEN] === 'Usual (100%)', st0.states[NIGHT] + ' / ' + st0.states[SCREEN]);
      i = await info();
      check('first options: the phone\'s own hours (config 23:59-23:59: no night) and the usual day level 0.18', i.settingIds.join() === NIGHT + ',' + SCREEN && i.settings.nightFrom === 'config' && i.settings.screen === 1 && !i.night && i.brightness === 0.18, JSON.stringify(i.settings) + ' b=' + i.brightness);
      await setH(SCREEN, 'Dimmer (70%)');
      i = await until((x) => x.brightness === 0.126, 3000);
      check('"Screen by day: Dimmer (70%)" takes the idle face to 0.126 within a moment', i.brightness === 0.126, 'b=' + i.brightness);
      await setH(NIGHT, '21:00 to 06:00');
      i = await until((x) => x.night, 3000);
      check('night hours "21:00 to 06:00" from HA: at 21:18 the face is night, as dark as it goes (the screen setting leaves night alone)', i.night && i.brightness === 0 && i.settings.nightFrom === 'ha', 'night=' + i.night + ' b=' + i.brightness + ' ' + JSON.stringify(i.settings));
      await setH(NIGHT, 'No night hours');
      i = await until((x) => !x.night, 3000);
      check('"No night hours": no night by the hours', !i.night && i.settings.night === '00:00-00:00', JSON.stringify(i.settings));
      await setH(SCREEN, 'Brighter (999%)');
      i = await until((x) => x.brightness === 0.18, 3000);
      check('an out-of-range screen option (999%) gives the usual level', i.brightness === 0.18 && i.settings.screen === 1, 'b=' + i.brightness);
      await setH(SCREEN, 'Brighter (140%)');
      i = await until((x) => x.brightness === 0.252, 3000);
      check('"Brighter (140%)": 0.252', i.brightness === 0.252, 'b=' + i.brightness);
      // a decimal or a sign makes the whole option unreadable (no 70 out of "70.5", no 70 out of "-70")
      for (const bad of ['Dimmer (70.5%)', 'Dimmer (-70%)']) {
        await setH(SCREEN, bad);
        i = await until((x) => x.brightness === 0.18, 3000);
        check('screen option ' + JSON.stringify(bad) + ': the usual level, not 70%', i.brightness === 0.18 && i.settings.screen === 1, 'b=' + i.brightness);
        await setH(SCREEN, 'Brighter (140%)');
        await until((x) => x.brightness === 0.252, 3000);
      }
      await setH(SCREEN, 'unavailable');
      i = await until((x) => x.brightness === 0.18, 3000);
      check('screen setting unavailable: usual level', i.brightness === 0.18, 'b=' + i.brightness);
      // the phone's own hours as 21:00-06:00 this time, so a fallback to them shows as night
      await p.inject(SHELL(Object.assign({}, cfg, { tempEntity: 'climate.thermostat', nightStart: '21:00', nightEnd: '06:00' })));
      await p.go(PAGE + '?time=21:18', 500);
      i = await until((x) => x.status === 'ready' && x.dataReady && !x.night, 8000);
      check('after a reload, HA\'s "No night hours" overrides the phone\'s own 21:00-06:00 (no night at 21:18)', !i.night && i.settings.nightFrom === 'ha', 'night=' + i.night + ' ' + JSON.stringify(i.settings));
      for (const [what, act] of [['unavailable', () => setH(NIGHT, 'unavailable')], ['malformed ("21:00 to 25:00")', () => setH(NIGHT, '21:00 to 25:00')],
                                 ['back to the first option', () => setH(NIGHT, "This phone's own hours")], ['removed', () => ctl('/control/remove?entity=' + NIGHT)]]) {
        await setH(NIGHT, 'No night hours'); await until((x) => !x.night, 3000);
        await act();
        i = await until((x) => x.night, 3000);
        check('night hours ' + what + ': the phone\'s own 21:00-06:00 again (night at 21:18)', i.night && i.settings.nightFrom === 'config' && i.settings.night === '21:00-06:00', 'night=' + i.night + ' ' + JSON.stringify(i.settings));
      }
      await setH(NIGHT, "This phone's own hours"); await setH(SCREEN, 'Usual (100%)');
      const leakS = (await shellCalls('log')).map((c) => c.a.join(' ')).filter((l) => l.indexOf(TOKEN) >= 0).length;
      check('...no token in the log', leakS === 0, String(leakS));
      await p.inject(SHELL(Object.assign({}, cfg, { tempEntity: 'climate.thermostat' })));   // the phone's own hours as before
    }

    // ---- mock mode (the demo house) keeps the same window, on the page's ?time= clock
    for (const [t, want] of [['21:18', 'refused'], ['07:30', 'runs']]) {
      await p.go(PAGE + '?mock=1&time=' + t, 500);
      i = await until((x) => x.status === 'ready' && x.dataReady, 8000);
      await p.tap(CX, 470 * u); await sleep(900);
      const x0 = await info(), gi = x0.moods.indexOf('good_morning'), at0 = Math.max(0, x0.cur);
      for (let k = 0; k < Math.abs(gi - at0); k++) { await p.key(gi > at0 ? 'ArrowRight' : 'ArrowLeft'); await sleep(650); }
      await sleep(900);
      await p.press(CX, 485 * u, 800);
      i = await until((x) => (want === 'runs' ? x.ha === 'good_morning' : /only runs/.test(x.cardNote)), 4000);
      check('mock mode at ' + t + ': Good Morning ' + want, i.mode === 'mock' && (want === 'runs' ? i.ha === 'good_morning' : i.cardNote === 'Good Morning only runs between 05:00 and 11:00.' && i.ha !== 'good_morning'), i.mode + ' ha=' + i.ha + ' "' + i.cardNote + '"');
    }
  } finally {
    const all = await ctl('/control/calls').catch(() => []);
    console.log('\nservice calls still in the fake log (since the last clear): ' + JSON.stringify(all.map((c) => c.domain + '.' + c.service + ' ' + c.entity_id.join(','))));
    await b.close();
    fake.kill();
    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed' + (failed.length ? '; FAILED: ' + failed.map((f) => f.name).join('; ') : ''));
    process.exitCode = failed.length ? 1 : 0;
  }
})().catch((e) => { console.error(e); process.exit(1); });
