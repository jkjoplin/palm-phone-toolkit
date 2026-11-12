#!/usr/bin/env node
/* A fake Home Assistant for testing the UI. No npm dependencies (Node's own http and crypto;
   the WebSocket server framing is written out below).

   It loads its moods by parsing the real package files in ha/packages/moods/ and runs them on
   HouseSim (ui/sim.js), the same simulation mock mode uses, so it speaks exactly what the UI uses
   of HA's WebSocket API: auth, get_states, subscribe_entities (partial diffs), subscribe_events,
   unsubscribe_events, call_service, ping.

   usage: node ui/dev/fake-ha.js [--port 8767] [--token test-token] [--never light.role_patio_lights]
                                 [--outside SECONDS] [--initial wind_down] [--previous lights_out]
                                 [--temp-entity sensor.bedroom_temperature] [--speed 1]
                                 [--moods ha/packages/moods] [--clock HH:MM] [--quiet]
   --clock pins the house's local time (hours and minutes) that mood time windows (mood_window) are
   checked against, so a test is the same whenever it runs; without it the real clock is used.

   Control (plain HTTP on the same port, for test drivers):
     GET /control/state                  current mood, previous, connections, entity states
     GET /control/calls                  every call_service received, oldest first (?clear=1 empties it)
     GET /control/drop                   close every WebSocket abruptly (TCP destroy, no close frame)
     GET /control/stall?ms=40000         the sockets open now stop answering (pings included) for ms and stay
                                         open: a half-open link. Sockets opened meanwhile work normally
     GET /control/lag?ms=10000&for=2000  what the sockets open now send during the next `for` ms reaches the phone ms
                                         late (in order); the phone's messages still reach HA at once. New sockets are not lagged
     GET /control/refuse?ms=5000         refuse new connections for ms (simulates HA restarting)
     GET /control/outside?slug=focus     something else (voice, the other phone) sets a mood; no slug = random
     GET /control/never?entity=ID        this entity never answers ('' for none)
     GET /control/vacation?on=1          Vacation mode on/off (mood_begin refuses all but away)
     GET /control/set?entity=ID&state=S  set any entity's state (e.g. a panel setting, input_select.moods_panel_bedroom_night_hours)
     GET /control/remove?entity=ID       remove an entity (a helper that is gone)
     GET /control/temp?value=71          the temperature sensor (&entity=climate.thermostat: a thermostat's
                                         current_temperature)
     GET /control/reload?dir=PATH        script reload: remove every mood script, re-create them from PATH
                                         (default: the folder loaded at start)
     GET /control/noop?entity=ID&on=1    that mood script runs but never calls mood_begin (a file missing its
                                         first two steps): the call succeeds and house_mood never moves
     GET /control/clock?at=HH:MM         pin the house clock the mood time windows read (at= empty: real time) */
'use strict';
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const HouseSim = require('../sim.js');
const { loadMoods, loadHelpers } = require('./mood-yaml');

const args = process.argv.slice(2);
function opt(name, def) { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : (i >= 0 ? true : def); }
const PORT = +opt('port', 8767);
const TOKEN = String(opt('token', 'test-token'));
const QUIET = !!opt('quiet', false);
const MOODS_DIR = path.resolve(opt('moods', path.join(__dirname, '..', '..', 'ha', 'packages', 'moods')));
const TEMP_ENTITY = String(opt('temp-entity', 'sensor.bedroom_temperature'));
const OUTSIDE_S = +opt('outside', 0);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
let pinned = HHMM.exec(String(opt('clock', '')));
function houseClock() { const d = new Date(); if (pinned) d.setHours(+pinned[1], +pinned[2]); return d; }

function log(m) { if (!QUIET) console.log(new Date().toISOString().slice(11, 23) + ' ' + m); }

const moods = loadMoods(MOODS_DIR);
log('loaded ' + moods.length + ' moods from ' + MOODS_DIR + ': ' + moods.map((m) => m.entity_id.replace(/^script\.mood_/, '')).join(', '));
const sim = new HouseSim({
  moods, token: TOKEN, never: String(opt('never', 'light.role_patio_lights')) === 'true' ? '' : String(opt('never', 'light.role_patio_lights')),
  initial: String(opt('initial', 'wind_down')), previous: String(opt('previous', 'lights_out')),
  tempEntity: TEMP_ENTITY, temp: 68, speed: +opt('speed', 1), log, clock: houseClock
});
// the settings helpers (moods_settings.yaml) at their first option, as Home Assistant creates them
const helpers = loadHelpers(MOODS_DIR);
Object.keys(helpers).forEach((id) => { const h = helpers[id]; if (Array.isArray(h.options) && h.options.length) sim.set(id, String(h.options[0]), { friendly_name: h.name || id, options: h.options.map(String), icon: h.icon }); });
log('settings helpers: ' + Object.keys(helpers).length);
if (OUTSIDE_S > 0) setInterval(() => { const id = sim.outside(); log('outside change on a timer -> ' + id); }, OUTSIDE_S * 1000);

/* ---------- WebSocket framing (RFC 6455, server side) ---------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(op, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | op;
  return Buffer.concat([head, payload]);
}
const sockets = new Set();
// A stall is a half-open link: the sockets open when it starts go silent (nothing sent, inbound
// held back) until it ends. A socket opened during the stall is a fresh link, and HA itself is
// fine, so it gets auth_required and everything else at once, exactly as real HA would.
let stallUntil = 0, refuseUntil = 0;
const stalled = new Map();   // socket -> time its stall ends
const lagged = new Map();    // socket -> { until, ms }: outbound messages sent before `until` arrive `ms` late

function accept(req, socket) {
  if (Date.now() < refuseUntil) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true);
  sockets.add(socket);
  const peer = socket.remoteAddress + ':' + socket.remotePort;
  log('ws open ' + peer);
  let buf = Buffer.alloc(0), frags = [], fragOp = 0, closed = false;
  const queue = [];   // while this socket is stalled, inbound messages wait here
  const isStalled = () => Date.now() < (stalled.get(socket) || 0);
  // /control/lag: what this socket sends during the lag window reaches the phone late, and in order
  // (everything after it waits behind it), while the phone's own messages reach HA at once
  let lastAt = 0;
  const send = (obj) => {
    const txt = JSON.stringify(obj);
    const write = () => { if (!closed && !socket.destroyed) socket.write(frame(1, Buffer.from(txt))); };
    const L = lagged.get(socket), lag = L && Date.now() < L.until ? L.ms : 0;
    if (!lag && lastAt <= Date.now()) { write(); return; }
    lastAt = Math.max(lastAt, Date.now() + lag);
    setTimeout(write, lastAt - Date.now());
  };
  const conn = sim.connect((obj) => { if (isStalled()) return; send(obj); });
  conn.onKill = () => { setTimeout(() => { try { socket.end(frame(8, Buffer.from([0x03, 0xe8]))); } catch (e) {} }, 20); };
  function deliver(text) {
    let msg; try { msg = JSON.parse(text); } catch (e) { return; }
    if (isStalled()) { queue.push(msg); return; }
    if (msg && msg.type === 'call_service') log('call_service ' + msg.domain + '.' + msg.service + ' ' + JSON.stringify(msg.target || msg.service_data || {}));
    else if (msg && msg.type && msg.type !== 'ping' && msg.type !== 'auth') log(msg.type + ' ' + JSON.stringify(msg).slice(0, 160));
    conn.receive(msg);
  }
  const unstall = setInterval(() => { if (!isStalled() && queue.length) queue.splice(0).forEach((m) => conn.receive(m)); }, 200);
  function done() { if (closed) return; closed = true; clearInterval(unstall); conn.close(); sockets.delete(socket); stalled.delete(socket); lagged.delete(socket); log('ws closed ' + peer); }
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f, masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.slice(off + (masked ? 4 : 0), need);
      if (masked) { const m = buf.slice(off, off + 4); payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4])); }
      buf = buf.slice(need);
      if (op === 8) { try { socket.end(frame(8, payload.slice(0, 2))); } catch (e) {} done(); return; }
      if (op === 9) { socket.write(frame(10, payload)); continue; }
      if (op === 10) continue;
      if (op === 0) { frags.push(payload); if (fin) { const all = Buffer.concat(frags); frags = []; if (fragOp === 1) deliver(all.toString('utf8')); } continue; }
      if (!fin) { fragOp = op; frags = [payload]; continue; }
      if (op === 1) deliver(payload.toString('utf8'));
    }
  });
  socket.on('close', done);
  socket.on('error', done);
}

/* ---------- HTTP: the control endpoints ---------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), q = Object.fromEntries(u.searchParams);
  const json = (o, code) => { res.writeHead(code || 200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o, null, 1)); };
  switch (u.pathname) {
    case '/control/state': {
      const st = {};
      Object.keys(sim.states).forEach((k) => { st[k] = sim.states[k].state; });
      return json({ mood: sim.states['input_text.house_mood'].state, previous: sim.states['input_text.house_mood_previous'].state,
        notice: sim.states['input_text.house_mood_notice'].state, connections: sockets.size, never: sim.never, stalled: Date.now() < stallUntil,
        clock: pinned ? pinned[0] : 'real', states: st });
    }
    case '/control/calls': { const c = sim.calls.slice(); if (q.clear) sim.calls.length = 0; return json(c); }
    case '/control/drop': { const n = sockets.size; sockets.forEach((s) => s.destroy()); log('dropped ' + n + ' connection(s)'); return json({ dropped: n }); }
    case '/control/stall': {
      stallUntil = Date.now() + (+q.ms || 40000);
      sockets.forEach((s) => stalled.set(s, stallUntil));
      log('stalled ' + sockets.size + ' open socket(s) for ' + (+q.ms || 40000) + ' ms; new sockets are not stalled');
      return json({ until: stallUntil, sockets: stalled.size });
    }
    case '/control/lag': {
      const ms = +q.ms || 10000, until = Date.now() + (+q.for || 2000);
      sockets.forEach((s) => lagged.set(s, { until, ms }));
      log('lagging what ' + sockets.size + ' open socket(s) send for ' + (+q.for || 2000) + ' ms by ' + ms + ' ms; new sockets are not lagged');
      return json({ until, ms, sockets: sockets.size });
    }
    case '/control/refuse': { refuseUntil = Date.now() + (+q.ms || 5000); log('refusing connections for ' + (+q.ms || 5000) + ' ms'); return json({ until: refuseUntil }); }
    case '/control/outside': { const id = sim.outside(q.slug); log('outside change -> ' + id); return json({ ran: id }); }
    case '/control/never': { sim.never = String(q.entity || ''); log('never answers: ' + (sim.never || '(none)')); return json({ never: sim.never }); }
    case '/control/vacation': { sim.set('input_boolean.vacation_mode', q.on === '1' ? 'on' : 'off'); return json({ vacation: q.on === '1' }); }
    case '/control/remove': { if (!q.entity) return json({ error: 'entity' }, 400); sim.remove(q.entity); return json({ ok: true }); }
    case '/control/set': { if (!q.entity) return json({ error: 'entity' }, 400); sim.set(q.entity, String(q.state)); return json({ ok: true }); }
    case '/control/reload': {
      // script.reload after the mood files changed: ?dir= another folder of mood files (default: the one loaded at start)
      const dir = q.dir ? path.resolve(q.dir) : MOODS_DIR;
      const fresh = loadMoods(dir);
      const n = sim.reloadMoods(fresh);
      log('reloaded ' + n + ' moods from ' + dir);
      return json({ moods: fresh.map((m) => m.entity_id.replace(/^script\.mood_/, '')) });
    }
    case '/control/noop': { if (!q.entity) return json({ error: 'entity' }, 400); if (q.on === '0') delete sim.noop[q.entity]; else sim.noop[q.entity] = true; log('no-op mood: ' + Object.keys(sim.noop).join(', ')); return json({ noop: Object.keys(sim.noop) }); }
    case '/control/clock': {
      if (q.at && !HHMM.test(q.at)) return json({ error: 'at must be HH:MM, or empty for real time' }, 400);
      pinned = q.at ? HHMM.exec(q.at) : null;
      log('house clock: ' + (pinned ? pinned[0] : 'real time'));
      return json({ clock: pinned ? pinned[0] : 'real' });
    }
    case '/control/temp': { sim.setTemp(q.entity || TEMP_ENTITY, q.value); return json({ ok: true }); }
    default: res.writeHead(404); res.end('fake Home Assistant: WebSocket at /api/websocket, control at /control/*\n');
  }
});
server.on('upgrade', (req, socket) => {
  if (new URL(req.url, 'http://x').pathname !== '/api/websocket') { socket.destroy(); return; }
  accept(req, socket);
});
server.listen(PORT, '127.0.0.1', () => log('fake Home Assistant on ws://127.0.0.1:' + PORT + '/api/websocket (token ' + (TOKEN ? 'set' : 'none') + ', never answers: ' + (sim.never || 'none') + ')'));
