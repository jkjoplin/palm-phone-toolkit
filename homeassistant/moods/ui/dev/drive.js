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
  // the custom mood runner on sim.js (the rules of script.moods_custom_run, with gen-custom.js's tables)
  {
    const HouseSim = require('../sim.js'), G = require('./gen-custom'), F = require('./fixtures/custom-cards.json');
    const slots = [1, 2, 3].map((n) => ({ entity_id: 'script.mood_custom_' + n, alias: 'Mood: Custom ' + n, attributes: { mood_slot: n, mood_holds_outdoor: false } }));
    const card = (n, v) => ({ entity_id: 'sensor.moods_custom_' + n, state: F.variants[n][v].state, attributes: { card: F.variants[n][v].card } });
    const sim = new HouseSim({ moods: require('./mood-yaml').loadMoods(path.join(__dirname, '..', '..', 'ha', 'packages', 'moods')).concat(slots), tables: G.TABLES, speed: 0.05, never: '',
      initial: 'wind_down', extras: [card(1, 'reading'), card(2, 'dusk'), card(3, 'red')], clock: () => { const d = new Date(); d.setHours(21, 18, 0, 0); return d; } });
    const S = (id) => sim.states[id] && sim.states[id].state;
    sim.set('light.role_bedroom_movie_lamp', 'on');
    sim.runSlot('script.mood_custom_3', 'custom_3');
    check('runner: refuses when its slot script is not running (a direct call): no service calls', sim.actions.length === 0, JSON.stringify(sim.actions));
    sim.runMood('script.mood_custom_3', 'test');
    await sleep(500);
    const offs = (sim.actions.find((a) => a.service === 'light.turn_off') || {}).entity_id || [];
    check('runner: "every other light off" with the movie lamp deep red 6% never turns the movie lamp off, never names the guest room, sends one colour key',
      S('input_text.house_mood') === 'custom_3' && offs.length > 3 && offs.indexOf('light.role_bedroom_movie_lamp') < 0 && !offs.some((e) => /guest_room/.test(e)) && S('light.role_bedroom_movie_lamp') === 'on' && S('light.role_bedroom_lamps') === 'off' &&
      sim.actions.some((a) => a.service === 'light.turn_on' && JSON.stringify(a.data) === '{"rgb_color":[150,8,6],"brightness_pct":6,"transition":10}') && sim.actions.some((a) => a.service === 'script.role_bedroom_tv_on'),
      JSON.stringify(sim.actions.map((a) => a.service + ' ' + a.entity_id.join(',') + ' ' + JSON.stringify(a.data))));
    sim.actions.length = 0;
    sim.set('sensor.moods_custom_1', 'ready', { card: Object.assign({}, F.variants[1].reading.card, { mood_steps: [{ lights: 'Guest room lamp', do: 'Soft white (2700 K)', pct: 40 }, { lights: 'Bedroom lamps', do: 'Off', pct: 0 }, { lights: 'Office lights', do: 'Keep its colour', pct: 400 }], mood_extras: { bed: 96, tv: 'maybe', fade: 1e9, others: 'guest_room' } }) });
    sim.runMood('script.mood_custom_1', 'test');
    await sleep(500);
    check('runner: an injected guest room role and a 96 F bed are skipped; pct 400 is 100, fade is at most 60, an unknown "others" leaves them',
      sim.actions.map((a) => a.service + ' ' + a.entity_id.join(',') + ' ' + JSON.stringify(a.data)).join(' / ') === 'light.turn_off light.role_bedroom_lamps {"transition":60} / light.turn_on light.role_office_lights {"brightness_pct":100,"transition":60}',
      JSON.stringify(sim.actions.map((a) => a.service + ' ' + a.entity_id.join(',') + ' ' + JSON.stringify(a.data))));
    sim.stop();
    // mock.js's custom card is the fixture's, as Home Assistant renders it
    const mockWin = {};
    new Function('window', 'setTimeout', fs.readFileSync(path.join(__dirname, '..', 'mock.js'), 'utf8'))(mockWin, setTimeout);
    const mc = mockWin.MockHA.extras('custom').find((x) => x.entity_id === 'sensor.moods_custom_1');
    check('mock.js ?mockset=custom carries the fixture\'s Reading card exactly', JSON.stringify(mc.attributes.card) === JSON.stringify(F.variants[1].reading.card), '');
  }
  const extra = [];   // more fakes and servers, stopped at the end
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

    // ---- the same, when HA's answer to the call arrives on time but the state diffs it writes a few
    // ms later are held (lost segments starting in that gap: TCP delivers the result and holds the
    // rest). The answer proves nothing about the store: the face must wait for a ping's pong before it
    // calls the mood unset. Then the Undo path under the same lags, and a 4.5 s lag that delivers
    // house_mood_previous alone after the card has gone back to the face.
    {
      i = await until((x) => x.view === 'idle', 4000);
      const from = i.shown;
      await ctl('/control/set?entity=light.role_office_lights&state=on');
      async function toFocus() {
        await until((x) => x.view === 'idle', 6000);
        await p.tap(CX, 470 * u); await sleep(900);
        const x = await info(), fi = x.moods.indexOf('focus'), at = Math.max(0, x.cur);
        for (let k = 0; k < Math.abs(fi - at); k++) { await p.key(fi > at ? 'ArrowRight' : 'ArrowLeft'); await sleep(650); }
        await sleep(900);
      }
      async function watch(ms, t0) {
        const seen = new Set(), notes = new Set();
        while (Date.now() - t0 < ms) {
          const x = await info();
          if (Date.now() - t0 > 700) seen.add(x.shown);
          if (x.faceNote || x.cardNote) notes.add((x.faceNote + ' ' + x.cardNote).trim());
          await sleep(150);
        }
        return { seen: [...seen], notes: [...notes] };
      }
      const outsideSince = (t) => p.eval('window.__moods.trail.filter(function(e){return e.t>=' + t + '&&e.kind==="outside"}).length');
      async function tapFaceUndo() {
        const r = JSON.parse(await p.eval('JSON.stringify(document.getElementById("faceUndo").getBoundingClientRect())'));
        await p.tap(r.left + r.width / 2, r.top + r.height / 2);
      }
      // 1) a hold: answer on time, diffs 10 s late
      await toFocus();
      await ctl('/control/lag?ms=10000&for=2500&after=result');
      let t0 = Date.now();
      await p.press(CX, 485 * u, 800);
      let w = await watch(14000, t0);
      i = await info();
      let st = await ctl('/control/state');
      check('a mood HA set whose answer is on time but whose diffs are 10 s late: the face ends on it and never says "didn\'t set"', st.mood === 'focus' && i.shown === 'focus' && i.ha === 'focus' && !w.notes.some((n) => /didn.t set/.test(n)),
        'house ' + st.mood + ', shown ' + i.shown + ', notes ' + JSON.stringify(w.notes));
      check('...and never goes back to ' + from + ' meanwhile', w.seen.indexOf(from) < 0, 'shown: ' + w.seen.join(','));
      await ctl('/control/outside?slug=' + from);
      await until((x) => x.shown === from && x.view === 'idle', 4000);
      await sleep(1200);
      // 2) a hold with everything 4.5 s late: the card is back on the face at 4 s, then
      // house_mood_previous arrives alone (house_mood a moment later). It is not an outside change
      // back to the old mood: no flash, and the face keeps its Undo.
      await toFocus();
      await ctl('/control/lag?ms=4500&for=1500');
      t0 = Date.now();
      await p.press(CX, 485 * u, 800);
      await sleep(6800 - (Date.now() - t0));
      i = await info();
      const outs = await outsideSince(t0);
      check('a hold whose answer is 4.5 s late: house_mood_previous arriving alone is no outside change, and the face keeps its Undo', i.view === 'idle' && i.shown === 'focus' && i.ha === 'focus' && outs === 0 && i.undo > 0 && i.undoTo === from,
        i.view + ' shown ' + i.shown + ' ha ' + i.ha + ', outside notes ' + outs + ', undo ' + i.undo + ' to ' + i.undoTo);
      // 3) that face Undo with everything 10 s late: HA does it at once; the no-answer timeout
      // reconnects and the reconnect's full state shows it. The face never flips back to Focus.
      await ctl('/control/lag?ms=10000&for=1500');
      t0 = Date.now();
      await tapFaceUndo();
      w = await watch(12000, t0);
      i = await info();
      st = await ctl('/control/state');
      check('a face Undo HA did while its answer is 10 s late: the face stays on ' + from + ', with no "didn\'t answer"', st.mood === from && i.shown === from && i.ha === from && w.seen.indexOf('focus') < 0 && !w.notes.some((n) => /didn.t answer|didn.t go through|Lost/.test(n)),
        'house ' + st.mood + ', shown ' + i.shown + ', seen ' + w.seen.join(',') + ', notes ' + JSON.stringify(w.notes));
      await sleep(600);
      // 4) a face Undo whose answer is on time but whose diffs are 10 s late: not "Undo didn't go through"
      await toFocus();
      await p.press(CX, 485 * u, 800);
      i = await until((x) => x.view === 'idle' && x.undo > 0 && x.ha === 'focus', 8000);
      await ctl('/control/lag?ms=10000&for=2500&after=result');
      t0 = Date.now();
      await tapFaceUndo();
      w = await watch(12000, t0);
      i = await info();
      st = await ctl('/control/state');
      check('a face Undo whose answer is on time but whose diffs are 10 s late: the face stays on ' + from + ', not "Undo didn\'t go through"', st.mood === from && i.shown === from && i.ha === from && w.seen.indexOf('focus') < 0 && !w.notes.some((n) => /didn.t go through|didn.t answer/.test(n)),
        'house ' + st.mood + ', shown ' + i.shown + ', seen ' + w.seen.join(',') + ', notes ' + JSON.stringify(w.notes));
      await until((x) => x.view === 'idle', 4000);
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

    // ======== custom moods (slots made on the Moods dashboard) and placement, on a second fake ========
    // The fake above served day one (every slot empty, every placement Usual): the deck was exactly
    // the 0.1.0 deck. This one serves the fixture set "ready": slot 1 Reading (bedroom lamps soft
    // white 40%), slot 2 Dusk (17:00 to 23:00), slot 3 Red room, slot 4 named but with nothing to do
    // (not ready), slots 5 and 6 empty. Cards are as Home Assistant renders them (fixtures/make-cards.py).
    if (!process.env.SKIP_CUSTOM) {
      const P2 = FAKE_PORT + 1, P3 = FAKE_PORT + 2, P4 = FAKE_PORT + 3;
      const c2 = (q) => new Promise((res, rej) => http.get('http://127.0.0.1:' + P2 + q, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { res(s); } }); }).on('error', rej));
      const cards = (body, q) => new Promise((res, rej) => {
        const data = body ? JSON.stringify(body) : '';
        const rq = http.request({ host: '127.0.0.1', port: P2, path: '/control/cards' + (q || ''), method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => res(s)); });
        rq.on('error', rej); rq.end(data);
      });
      const setH = (id, s) => c2('/control/set?entity=' + id + '&state=' + encodeURIComponent(s));
      const BUILT = ['wind_down', 'movie_night', 'afterglow', 'lights_out', 'good_morning', 'focus', 'hosting', 'away', 'showcase'];
      const DECK = BUILT.concat(['custom_1', 'custom_2', 'custom_3']);
      const con0 = p.console.length;
      const fake2 = spawn(process.execPath, [path.join(__dirname, 'fake-ha.js'), '--port', String(P2), '--token', TOKEN, '--never', '', '--initial', 'wind_down', '--previous', 'lights_out', '--clock', '21:18', '--card-set', 'ready', '--quiet'], { stdio: 'inherit' });
      extra.push(fake2);
      await sleep(900);
      const cfg2 = Object.assign({}, cfg, { haUrl: 'ws://127.0.0.1:' + P2 + '/api/websocket' });
      await p.inject(SHELL(cfg2));
      await p.go(PAGE + '?time=21:18', 500);
      i = await until((x) => x.status === 'ready' && x.dataReady && x.moods.length === DECK.length, 8000);
      async function deck2(slug) {
        await until((x) => x.view === 'idle', 6000);
        await p.tap(CX, 470 * u); await sleep(900);
        const x = await info(), idx = x.moods.indexOf(slug), at = Math.max(0, x.cur);
        for (let k = 0; k < Math.abs(idx - at); k++) { await p.key(idx > at ? 'ArrowRight' : 'ArrowLeft'); await sleep(600); }
        await sleep(900);
        return idx;
      }
      const cardName = (idx) => p.eval('(function(){var c=document.querySelectorAll(".card")[' + idx + '];return c?c.querySelector(".name").textContent+"|"+c.querySelector(".desc").textContent+"|"+c.querySelector(".scope").textContent:""})()');

      // 1) a ready slot: shown in its order, hold sets it, its marks fill
      check('custom: the ready slots come after the built-ins in their order (110, 120, 130); a not-ready and the empty slots are not shown', i.moods.join() === DECK.join(), i.moods.join(','));
      let idx = await deck2('custom_1');
      const nm = await cardName(idx);
      check('custom: the slot\'s card shows its name, card text and scope from sensor.moods_custom_1', /^Reading\|Bedroom lamps soft white \(2700 K\), 40%\.\|Bedroom/.test(nm), nm);
      await p.shot(path.join(SHOTS, PFX + SUFFIX + '-custom-card.png'));
      await c2('/control/calls?clear=1'); await c2('/control/actions?clear=1');
      await p.press(CX, 485 * u, 800);
      i = await until((x) => x.ha === 'custom_1' && x.marks && x.marks.every((m) => /:ok$/.test(m)), 6000);
      let calls = await c2('/control/calls'), acts = await c2('/control/actions');
      check('custom: a hold calls script.turn_on script.mood_custom_1, house_mood becomes custom_1 and its mark fills',
        calls.length === 1 && calls[0].entity_id[0] === 'script.mood_custom_1' && i.ha === 'custom_1' && i.shown === 'custom_1' && i.marks && i.marks.join() === 'Lamps:ok',
        JSON.stringify(calls.map((c) => c.service + ' ' + c.entity_id)) + ' ha=' + i.ha + ' marks=' + JSON.stringify(i.marks));
      check('custom: the runner sends light.turn_on to light.role_bedroom_lamps with 2700 K and 40% (one colour key), nothing else',
        acts.length === 1 && acts[0].service === 'light.turn_on' && acts[0].entity_id.join() === 'light.role_bedroom_lamps' && JSON.stringify(acts[0].data) === '{"color_temp_kelvin":2700,"brightness_pct":40,"transition":2}',
        JSON.stringify(acts.map((a) => a.service + ' ' + a.entity_id + ' ' + JSON.stringify(a.data))));
      i = await until((x) => x.view === 'idle', 9000);
      check('custom: the face shows the custom mood', /^Reading/.test(i.status_line), '"' + i.status_line + '"');

      // 5) switched off between deck open and hold: the deck is not rebuilt under the finger, and the
      // hold is refused with the package's reason
      await sleep(600);
      idx = await deck2('custom_1');
      await cards({ 1: 'reading_off' });
      await sleep(2800);
      i = await info();
      const n5 = await p.eval('document.querySelectorAll(".card").length');
      check('custom: a slot switched off while the deck is open stays on the open deck (never rebuilt under a finger)', i.view === 'deck' && n5 === DECK.length && i.moods.indexOf('custom_1') >= 0, i.view + ' ' + n5 + ' cards');
      await p.press(CX, 485 * u, 800);
      i = await until((x) => /switched off/.test(x.cardNote), 4000);
      check('custom: ...a hold on it is refused with the package\'s reason', i.cardNote === 'Reading is switched off on the Moods dashboard.', '"' + i.cardNote + '"');
      await p.key('Escape');
      i = await until((x) => x.view === 'idle' && x.moods.indexOf('custom_1') < 0, 5000);
      check('custom: ...and back on the face the slot has gone (it is still the house\'s mood: the face shows no mood)', i.moods.indexOf('custom_1') < 0 && i.moods.length === DECK.length - 1 && i.cur === -1, i.moods.join(',') + ' cur ' + i.cur);

      // 2) not_ready on the idle face: removed after the 2 s shrink settle, with no page reload
      await cards({ 1: 'reading' });
      i = await until((x) => x.moods.indexOf('custom_1') >= 0, 3000);
      check('custom: switched on again, it comes back at once (no reload)', i.moods.join() === DECK.join(), i.moods.join(','));
      await p.eval('window.__noReload = 1');
      await cards({ 1: 'reading_off' });
      await sleep(1200);
      const mid = await info();
      i = await until((x) => x.moods.indexOf('custom_1') < 0, 4000);
      const same = await p.eval('window.__noReload === 1');
      check('custom: a card turned not_ready removes the slot only after the 2 s shrink settle, without a page reload', mid.moods.indexOf('custom_1') >= 0 && i.moods.indexOf('custom_1') < 0 && same === true, 'at 1.2 s ' + mid.moods.length + ', then ' + i.moods.length + ' moods; same page ' + same);
      await cards({ 1: 'reading' });
      await until((x) => x.moods.indexOf('custom_1') >= 0, 3000);

      // 3) no news: an unavailable or removed card sensor, or a garbage card, keeps the last good card;
      // a card of the wrong types drops the slot. Built-ins are never affected.
      for (const [what, act] of [['unavailable (card attribute gone)', () => cards(null, '?slot=1&state=unavailable')], ['removed', () => cards({ 1: null })],
                                 ['garbage text', () => cards(null, '?slot=1&raw=' + encodeURIComponent('{not json'))]]) {
        await act();
        await sleep(2800);
        i = await info();
        check('custom: card sensor ' + what + ': no news, the slot keeps its last card', i.moods.join() === DECK.join(), i.moods.join(','));
        await cards({ 1: 'reading' }); await sleep(500);
      }
      await cards({ 1: { state: 'ready', card: { mood: 'yes', mood_slot: 'one', mood_name: ['x'], mood_touches: 'nope' } } });
      i = await until((x) => x.moods.indexOf('custom_1') < 0, 4000);
      check('custom: a card of the wrong types drops the slot; the built-ins are unaffected', i.moods.join() === DECK.filter((s) => s !== 'custom_1').join(), i.moods.join(','));
      await cards({ 1: { state: 'ready', card: { mood: true, mood_slot: 1, mood_name: 'Odd', mood_touches: [{ label: 'Plug', entity: 'switch.kitchen_kettle', expect: 'on' }, { label: 'Lamp', entity: 'light.role_bedroom_lamps', expect: 'on' }], mood_palette: 'red', mood_order: 'soon' } } });
      i = await until((x) => x.moods.indexOf('custom_1') >= 0, 3000);
      idx = i.moods.indexOf('custom_1');
      const odd = await p.eval('(function(){var c=document.querySelectorAll(".card")[' + idx + '];return c.querySelector(".name").textContent+"|"+Array.prototype.map.call(c.querySelectorAll(".touches .lb"),function(e){return e.textContent}).join(",")})()');
      check('custom: a ready card with odd values degrades (defaults; a touch that is not a role entity is dropped), last by order', odd === 'Odd|Lamp' && i.moods[i.moods.length - 1] === 'custom_1', odd + ' / ' + i.moods.join(','));
      await cards({ 1: 'reading' });
      i = await until((x) => x.moods.join() === DECK.join(), 4000);

      // 4) the slot script removed (a reload while the deck is open): a hold is refused by the existing rule
      idx = await deck2('custom_1');
      await c2('/control/remove?entity=script.mood_custom_1');
      await sleep(600);
      await c2('/control/calls?clear=1');
      await p.press(CX, 485 * u, 800);
      await sleep(500);
      i = await info(); calls = await c2('/control/calls');
      check('custom: with its slot script gone, a hold says the mood is gone and calls nothing', /gone from Home Assistant/.test(i.cardNote) && calls.length === 0, '"' + i.cardNote + '" calls ' + calls.length);
      await p.key('Escape');
      await c2('/control/reload');
      i = await until((x) => x.view === 'idle' && x.moods.join() === DECK.join(), 6000);
      check('custom: a script reload brings the slot scripts back', i.moods.join() === DECK.join(), i.moods.join(','));

      // 6) windows from the card: refused outside (the reason uses the custom name), accepted inside,
      // and vacation is still checked first
      await c2('/control/clock?at=12:00');
      await c2('/control/vacation?on=1');
      await deck2('custom_2');
      await p.press(CX, 485 * u, 800);
      i = await until((x) => /Vacation|only runs/.test(x.cardNote), 4000);
      check('custom: vacation mode wins over the slot\'s window', /^Vacation mode is on/.test(i.cardNote), '"' + i.cardNote + '"');
      await c2('/control/vacation?on=0');
      await p.key('Escape'); await sleep(1300);
      await deck2('custom_2');
      await p.press(CX, 485 * u, 800);
      i = await until((x) => /only runs/.test(x.cardNote), 4000);
      let st = await c2('/control/state');
      check('custom: outside its window (12:00) Dusk is refused with "Dusk only runs between 17:00 and 23:00."', i.cardNote === 'Dusk only runs between 17:00 and 23:00.' && st.mood !== 'custom_2', '"' + i.cardNote + '" house ' + st.mood);
      await p.key('Escape'); await sleep(1300);
      await c2('/control/clock?at=21:18');
      await c2('/control/actions?clear=1');
      await deck2('custom_2');
      await p.press(CX, 485 * u, 800);
      i = await until((x) => x.ha === 'custom_2' && x.marks && x.marks.every((m) => /:ok$/.test(m)), 6000);
      acts = await c2('/control/actions');
      const off = (acts.find((a) => a.service === 'light.turn_off') || {}).entity_id || [];
      check('custom: inside it (21:18) Dusk runs: loft amber, the other indoor lights off (never the loft), the diffuser on',
        i.ha === 'custom_2' && acts.some((a) => a.service === 'light.turn_on' && a.entity_id[0] === 'light.role_loft_lamp' && JSON.stringify(a.data.rgb_color) === '[255,140,40]') &&
        off.indexOf('light.role_loft_lamp') < 0 && off.indexOf('light.role_bedroom_lamps') >= 0 && acts.some((a) => a.service === 'switch.turn_on'),
        'ha=' + i.ha + ' ' + JSON.stringify(acts.map((a) => a.service + ' ' + a.entity_id.join(','))));
      i = await until((x) => x.view === 'idle', 9000);

      // 5b) Undo into a cleared slot is refused (the house keeps the mood it has)
      await deck2('wind_down');
      await p.press(CX, 485 * u, 800);
      i = await until((x) => x.ha === 'wind_down' && x.undo > 0, 4000);
      const undoTo = i.undoTo;
      await cards({ 2: 'empty' });
      await sleep(400);
      await p.tap(CX, 592 * u);
      i = await until((x) => /cleared/.test(x.faceNote), 5000);
      st = await c2('/control/state');
      check('custom: an Undo into a slot cleared meanwhile is refused with the reason; the house stays on Wind Down',
        undoTo === 'custom_2' && st.mood === 'wind_down' && i.faceNote === 'That custom mood was cleared on the Moods dashboard.' && i.shown === 'wind_down',
        'undo to ' + undoTo + ', house ' + st.mood + ', "' + i.faceNote + '" shown ' + i.shown);
      await cards({ 2: 'dusk' });
      i = await until((x) => x.view === 'idle' && x.moods.join() === DECK.join(), 8000);

      // 7) placement on this (bedroom) panel
      const order = async (want, what, ms) => {
        i = await until((x) => x.moods.join() === want.join(), ms || 4000);
        check('placement: ' + what, i.moods.join() === want.join(), i.moods.join(','));
      };
      const without = (l, s) => l.filter((x) => [].concat(s).indexOf(x) < 0);
      await setH('input_select.moods_focus_where', 'Not on the Bedroom Palm');
      await order(without(DECK, 'focus'), '"Not on the Bedroom Palm" hides Focus here (after the shrink settle)');
      await setH('input_select.moods_custom_2_where', 'Only on the Living room Palm');
      await order(without(DECK, ['focus', 'custom_2']), '"Only on the Living room Palm" hides a slot here');
      await setH('input_select.moods_away_where', 'First on every phone');
      const placed = ['away'].concat(without(DECK, ['focus', 'custom_2', 'away']));
      await order(placed, '"First on every phone" sorts Away first');
      await setH('input_number.moods_custom_3_order', '5');
      // Hosting (order 70) and the slots are not this panel's moods: Red room's 5 puts it first among them
      const placed2 = without(placed, 'custom_3'); placed2.splice(placed2.indexOf('hosting'), 0, 'custom_3');
      await order(placed2, 'order 5 moves Red room (130) ahead of Hosting (70) and Reading (110), the other moods that are not this panel\'s');
      for (const v of ['abc', 'unavailable', '0', '1000', '5.5e9']) {
        await setH('input_number.moods_custom_3_order', v);
        await order(placed, 'order "' + v + '" is the usual order');
        await setH('input_number.moods_custom_3_order', '5');
        await until((x) => x.moods.join() === placed2.join(), 3000);
      }
      await c2('/control/remove?entity=input_number.moods_custom_3_order');
      await order(placed, 'a removed order helper is the usual order');
      for (const v of ['unavailable', 'Not on the Bedroom palm', '']) {
        await setH('input_select.moods_focus_where', v);
        await order(['away'].concat(without(DECK, ['custom_2', 'away'])), 'where ' + JSON.stringify(v) + ' is the usual rule (Focus back)');
        await setH('input_select.moods_focus_where', 'Not on the Bedroom Palm');
        await until((x) => x.moods.indexOf('focus') < 0, 4000);
      }
      await p.shot(path.join(SHOTS, PFX + SUFFIX + '-placed.png'));
      // hiding every mood is ignored (logged once)
      for (const s of DECK.concat(['custom_4', 'custom_5', 'custom_6'])) await setH('input_select.moods_' + s + '_where', 'Hidden on every phone');
      await sleep(3000);
      i = await info();
      const warned = (await shellCalls('log')).some((c) => /hiding ignored/.test(c.a[1]));
      check('placement: hiding every mood is ignored here (the usual deck), and logged', i.moods.join() === DECK.join() && i.hiddenHere.length === 0 && warned, i.moods.join(',') + ' warned=' + warned);
      for (const s of DECK.concat(['custom_4', 'custom_5', 'custom_6'])) await setH('input_select.moods_' + s + '_where', 'Usual (as the mood says)');
      await order(DECK, 'every helper back to Usual: the usual deck');

      // 8) a hidden mood that is current stays (last, flagged), and the face shows it
      st = await c2('/control/state');
      const curS = st.mood;
      await setH('input_select.moods_' + curS + '_where', 'Hidden on every phone');
      await sleep(2800);
      i = await info();
      check('placement: the current mood (' + curS + '), hidden, stays on the deck, last, flagged hiddenHere; the face shows it',
        i.moods[i.moods.length - 1] === curS && i.hiddenHere.join() === curS && i.shown === curS && i.cur === i.moods.length - 1 && i.status_line.length > 0 && !/Tap to choose/.test(i.status_line), i.moods.join(',') + ' hidden ' + i.hiddenHere + ' "' + i.status_line + '"');
      await c2('/control/outside?slug=focus');
      i = await until((x) => x.shown === 'focus' && x.moods.indexOf(curS) < 0, 5000);
      check('placement: once the house moves on (voice sets Focus), the hidden mood goes', i.moods.indexOf(curS) < 0 && i.shown === 'focus', i.moods.join(','));
      await setH('input_select.moods_' + curS + '_where', 'Usual (as the mood says)');
      await until((x) => x.moods.indexOf(curS) >= 0, 3000);
      await setH('input_select.moods_hosting_where', 'Not on the Bedroom Palm');
      await until((x) => x.moods.indexOf('hosting') < 0, 4000);
      const sawChoose = [];
      await c2('/control/outside?slug=hosting');
      for (let k = 0; k < 12; k++) { const x = await info(); sawChoose.push(/Tap to choose/.test(x.status_line) ? 1 : 0); await sleep(100); }
      i = await until((x) => x.shown === 'hosting' && x.hiddenHere.join() === 'hosting', 4000);
      check('placement: a mood hidden here that becomes current from outside is shown at once, last, and the face shows it (no "Tap to choose")',
        i.moods[i.moods.length - 1] === 'hosting' && /Hosting/.test(i.status_line) && sawChoose.indexOf(1) < 0, i.moods.join(',') + ' "' + i.status_line + '"');

      // 9) a boot with Home Assistant away: the v2 cache shows the slots and placement
      await setH('input_select.moods_away_where', 'First on every phone');
      i = await until((x) => x.moods[0] === 'away', 4000);
      await sleep(600);
      const want9 = i.moods.join();
      const keys = await p.eval('JSON.stringify(Object.keys(localStorage))');
      await c2('/control/refuse?ms=12000'); await c2('/control/drop');
      await p.go(PAGE + '?time=21:18', 1500);
      i = await info();
      check('cache: a boot with Home Assistant away draws the deck from the v2 cache, slots and placement included', i.status !== 'ready' && i.moods.join() === want9 && /moods\.cache\.v2/.test(keys) && !/moods\.cache\.v1"/.test(keys), i.status + ' ' + i.moods.join(',') + ' keys ' + keys);
      i = await until((x) => x.status === 'ready', 20000, 250);
      await setH('input_select.moods_away_where', 'Usual (as the mood says)');
      await setH('input_select.moods_hosting_where', 'Usual (as the mood says)');
      await setH('input_select.moods_focus_where', 'Usual (as the mood says)');
      await setH('input_select.moods_custom_2_where', 'Usual (as the mood says)');
      // a v1 cache (the 0.1.0 key) is ignored
      await p.eval('localStorage.removeItem("moods.cache.v2"); localStorage.setItem("moods.cache.v1", JSON.stringify({t: Date.now(), panel: "bedroom", a: {"script.mood_bogus": {s: "off", a: {mood: true, mood_name: "Bogus"}}}}))');
      await c2('/control/refuse?ms=6000'); await c2('/control/drop');
      await p.go(PAGE + '?time=21:18', 1200);
      i = await info();
      check('cache: a v1 cache is not read', i.moods.length === 0 && i.status !== 'ready', i.moods.join(',') + ' ' + i.status);
      await until((x) => x.status === 'ready', 20000, 250);

      // mock mode with ?mockset=custom: a ready slot, a switched-off one, and placement
      await p.go(PAGE + '?mock=1&mockset=custom&time=21:18', 500);
      i = await until((x) => x.status === 'ready' && x.dataReady, 8000);
      check('mock mode ?mockset=custom: Good Morning first (order 5), Movie Night hidden here, Reading shown, Dusk (switched off) not',
        i.moods.join() === 'good_morning,wind_down,afterglow,lights_out,custom_1', i.moods.join(','));
      await p.tap(CX, 470 * u); await sleep(900);
      { const x = await info(), gi = x.moods.indexOf('custom_1'), at0 = Math.max(0, x.cur); for (let k = 0; k < Math.abs(gi - at0); k++) { await p.key(gi > at0 ? 'ArrowRight' : 'ArrowLeft'); await sleep(600); } }
      await sleep(900);
      await p.press(CX, 485 * u, 800);
      i = await until((x) => x.ha === 'custom_1' && x.marks && x.marks.every((m) => /:ok$/.test(m)), 6000);
      check('...and Reading can be set there, its mark fills', i.ha === 'custom_1' && i.marks && i.marks.join() === 'Lamps:ok', i.ha + ' ' + JSON.stringify(i.marks));
      await p.shot(path.join(SHOTS, PFX + SUFFIX + '-mock-custom.png'));

      // 10) a house from before custom moods (no slots, no cards, no placement helpers): today's deck
      const fake3 = spawn(process.execPath, [path.join(__dirname, 'fake-ha.js'), '--port', String(P3), '--token', TOKEN, '--never', '', '--initial', 'wind_down', '--previous', 'lights_out', '--clock', '21:18', '--old-house', '--quiet'], { stdio: 'inherit' });
      extra.push(fake3);
      await sleep(900);
      await p.inject(SHELL(Object.assign({}, cfg, { haUrl: 'ws://127.0.0.1:' + P3 + '/api/websocket' })));
      await p.go(PAGE + '?time=21:18', 500);
      i = await until((x) => x.status === 'ready' && x.dataReady && x.moods.length > 0, 8000);
      check('old house (no custom mood entities at all): exactly the 0.1.0 deck', i.moods.join() === BUILT.join() && i.shown === 'wind_down', i.moods.join(','));

      // 11) the 0.1.0 build (app.js and moods.js from before this change) against the house with slots
      // and placement: no slot cards, placement ignored
      let oldRev = '';
      try {
        const { execFileSync } = require('child_process');
        const R = path.join(__dirname, '..', '..');
        const revs = execFileSync('git', ['log', '--format=%H', '--', 'ui/app.js'], { cwd: R }).toString().trim().split('\n');
        for (const r of revs) { if (execFileSync('git', ['show', r + ':./ui/app.js'], { cwd: R }).toString().indexOf('entity_globs') < 0) { oldRev = r; break; } }
        if (oldRev) {
          const tmpUi = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-oldui-'));
          const UI = path.join(__dirname, '..');
          fs.readdirSync(UI).forEach((f) => { const s = path.join(UI, f); if (f !== 'dev' && f !== 'fonts' && fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(tmpUi, f)); });
          ['app.js', 'moods.js'].forEach((f) => fs.writeFileSync(path.join(tmpUi, f), execFileSync('git', ['show', oldRev + ':./ui/' + f], { cwd: R })));
          const srv = http.createServer((rq, rs) => {
            const f = path.join(tmpUi, path.basename(new URL(rq.url, 'http://x').pathname) || 'index.html');
            fs.readFile(f, (e, d) => { if (e) { rs.writeHead(404); rs.end(); return; } rs.writeHead(200, { 'content-type': /\.js$/.test(f) ? 'text/javascript' : /\.css$/.test(f) ? 'text/css' : 'text/html' }); rs.end(d); });
          });
          await new Promise((r) => srv.listen(P4, '127.0.0.1', r));
          extra.push({ kill: () => { srv.close(); fs.rmSync(tmpUi, { recursive: true, force: true }); } });
          await setH('input_select.moods_away_where', 'First on every phone');
          await p.inject(SHELL(cfg2));
          await p.go('http://127.0.0.1:' + P4 + '/index.html?time=21:18', 500);
          i = await until((x) => x.status === 'ready' && x.dataReady && x.moods.length > 0, 8000);
          check('the 0.1.0 build (app.js and moods.js at ' + oldRev.slice(0, 7) + ') with slots and placement present: no slot cards, placement ignored', i.moods.join() === BUILT.join(), i.moods.join(','));
          await setH('input_select.moods_away_where', 'Usual (as the mood says)');
        }
      } catch (e) { console.log('old build check: ' + e.message); }
      if (!oldRev) check('the 0.1.0 build check found the old app.js in git', false, 'no commit of ui/app.js without entity_globs');

      const ex2 = p.console.slice(con0).filter((l) => /EXCEPTION|error/i.test(l));
      check('custom: no exceptions in the page', ex2.length === 0, ex2.join(' | '));
    }
  } finally {
    const all = await ctl('/control/calls').catch(() => []);
    console.log('\nservice calls still in the fake log (since the last clear): ' + JSON.stringify(all.map((c) => c.domain + '.' + c.service + ' ' + c.entity_id.join(','))));
    await b.close();
    fake.kill();
    extra.forEach((x) => { try { x.kill(); } catch (e) {} });
    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed' + (failed.length ? '; FAILED: ' + failed.map((f) => f.name).join('; ') : ''));
    process.exitCode = failed.length ? 1 : 0;
  }
})().catch((e) => { console.error(e); process.exit(1); });
