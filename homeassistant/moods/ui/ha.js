/* Palm Moods: a minimal Home Assistant WebSocket client (classic script, window.HAClient).
   - auth with a long-lived token; auth_invalid is NOT retried quickly (HA bans IPs that keep failing):
     it waits AUTH_RETRY_MS and reports 'auth_invalid'.
   - subscribe_entities with a filter, so the phone only receives the entities it shows
     (HA 2026.11: no admin needed; states are filtered by the user's read permission).
     Change events are partial diffs and are merged here, never replaced.
   - call_service, sync() (a ping whose pong proves the store has everything HA sent before it),
     ping every 30 s (a missing pong within 10 s drops the socket), reconnect with
     backoff 1 s -> 30 s, kick() to retry at once (Wi-Fi back, app resumed), probe() to check a
     quiet socket without touching the backoff (any other network event).
   The token is held in this closure only; nothing here logs it or the config. */
(function () {
  'use strict';

  var PING_MS = 30000, PONG_TIMEOUT_MS = 10000, CONNECT_TIMEOUT_MS = 15000, AUTH_RETRY_MS = 5 * 60000;
  var BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];

  function HAClient(opts) {
    var url = opts.url, token = opts.token;
    var makeSocket = opts.socket || function (u) { return new WebSocket(u); };
    var onStatus = opts.onStatus || function () {};
    var self = this;
    var ws = null, nextId = 1, pending = {}, subs = {}, status = 'idle', attempt = 0;
    var tRetry = 0, tPing = 0, tPong = 0, tConnect = 0, stopped = false;
    var lastRx = 0, pingId = 0;

    function setStatus(s, detail) { if (status !== s) { status = s; onStatus(s, detail); } }
    function clearTimers() { clearTimeout(tPing); clearTimeout(tPong); clearTimeout(tConnect); tPing = tPong = tConnect = 0; }

    function connect() {
      clearTimeout(tRetry); tRetry = 0;
      if (stopped) return;
      clearTimers();
      setStatus('connecting');
      var sock;
      try { sock = makeSocket(url); } catch (e) { drop('socket'); return; }
      ws = sock;
      tConnect = setTimeout(function () { if (ws === sock && status !== 'ready') { try { sock.close(); } catch (e) {} lost(sock, 'timeout'); } }, CONNECT_TIMEOUT_MS);
      sock.onmessage = function (ev) {
        if (ws !== sock) return;
        lastRx = Date.now();
        var data;
        try { data = JSON.parse(ev.data); } catch (e) { return; }
        if (Array.isArray(data)) data.forEach(function (m) { handle(sock, m); }); else handle(sock, data);
      };
      sock.onclose = function () { lost(sock, 'closed'); };
      sock.onerror = function () { /* onclose follows */ };
    }

    function handle(sock, m) {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'auth_required') { raw(sock, { type: 'auth', access_token: token }); return; }
      if (m.type === 'auth_invalid') { authFailed(sock); return; }
      if (m.type === 'auth_ok') { ready(sock); return; }
      if (m.type === 'pong') { resolve(m.id, true, null); if (m.id === pingId) { clearTimeout(tPong); tPong = 0; } return; }
      if (m.type === 'result') { resolve(m.id, m.success !== false, m.success === false ? (m.error || { code: 'unknown', message: 'failed' }) : m.result); return; }
      if (m.type === 'event') {
        for (var k in subs) {
          var s = subs[k];
          if (s.wsId === m.id) { try { s.cb(m.event, s.fresh); } catch (e) { if (opts.onError) opts.onError(e); } s.fresh = false; return; }
        }
      }
    }

    function raw(sock, obj) { try { sock.send(JSON.stringify(obj)); return true; } catch (e) { return false; } }

    function ready(sock) {
      clearTimeout(tConnect); tConnect = 0;
      attempt = 0;
      setStatus('ready');
      // (re)establish every subscription on this new socket; each answers with a fresh full dump
      for (var k in subs) open(subs[k]);
      schedulePing();
    }

    function open(s) {
      s.fresh = true;
      var r = send(s.msg);
      s.wsId = r.id;
      r.promise.catch(function (e) { if (opts.onSubError) opts.onSubError(s.key, e); });
    }

    function authFailed(sock) {
      clearTimers();
      ws = null;
      try { sock.onclose = null; sock.close(); } catch (e) {}
      failAll('auth_invalid');
      setStatus('auth_invalid');
      tRetry = setTimeout(connect, AUTH_RETRY_MS);
    }

    function lost(sock, why) {
      if (ws !== sock) return;
      ws = null;
      clearTimers();
      failAll(why);
      drop(why);
    }
    function drop(why) {
      if (stopped) return;
      setStatus('down', why);
      var ms = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
      ms = Math.round(ms * (0.85 + Math.random() * 0.3));
      attempt++;
      clearTimeout(tRetry);
      tRetry = setTimeout(connect, ms);
    }
    function failAll(why) {
      var p = pending; pending = {};
      for (var k in p) { try { p[k].reject({ code: 'disconnected', message: why }); } catch (e) {} }
      for (var s in subs) subs[s].wsId = -1;
    }

    function schedulePing() {
      clearTimeout(tPing);
      tPing = setTimeout(function () { ping(); }, PING_MS);
    }
    function ping() {
      var sock = ws;
      if (!sock || status !== 'ready') return;
      var r = send({ type: 'ping' });
      r.promise.catch(function () {});
      pingId = r.id;   // only this ping's pong clears its timeout (a sync() pong may come first)
      clearTimeout(tPong);
      tPong = setTimeout(function () {
        // no pong: the socket may look open long after Wi-Fi went away
        if (ws === sock) { try { sock.close(); } catch (e) {} lost(sock, 'no pong'); }
      }, PONG_TIMEOUT_MS);
      schedulePing();
    }

    function resolve(id, ok, val) {
      var p = pending[id];
      if (!p) return;
      delete pending[id];
      if (ok) p.resolve(val); else p.reject(val);
    }

    function send(msg) {
      var id = nextId++;
      msg.id = id;
      var pr = new Promise(function (res, rej) { pending[id] = { resolve: res, reject: rej }; });
      if (!ws || status !== 'ready' || !raw(ws, msg)) { var p = pending[id]; delete pending[id]; p.reject({ code: 'disconnected', message: 'not connected', unsent: true }); }
      return { id: id, promise: pr };
    }

    /* public */
    this.start = function () { stopped = false; connect(); };
    this.stop = function () { stopped = true; clearTimers(); clearTimeout(tRetry); if (ws) { var s = ws; ws = null; try { s.close(); } catch (e) {} } setStatus('idle'); };
    this.status = function () { return status; };
    /* the link looks open but answers nothing: drop it and reconnect now */
    this.restart = function () {
      if (!ws) return;
      var s = ws;
      try { s.close(); } catch (e) {}
      attempt = 0;
      lost(s, 'restart');
    };
    this.ready = function () { return status === 'ready'; };
    /* Resolves once HA has answered a ping sent now. HA sends in order over one TCP stream, so by then
       everything it sent before the ping (every state diff) has been through the store: the store is
       current. Rejects when the link is down or goes with it; a pong missing for 10 s drops the socket. */
    this.sync = function () {
      var sock = ws;
      if (!sock || status !== 'ready') return Promise.reject({ code: 'disconnected', message: 'not connected', unsent: true });
      var r = send({ type: 'ping' });
      var t = setTimeout(function () { if (ws === sock) { try { sock.close(); } catch (e) {} lost(sock, 'no pong'); } }, PONG_TIMEOUT_MS);
      return r.promise.then(function (v) { clearTimeout(t); return v; }, function (e) { clearTimeout(t); throw e; });
    };
    /* a hint that the network may have changed (Wi-Fi gone, a new RSSI): if up and quiet, ping.
       Never touches the backoff, so routine events cannot turn it into a tight retry loop. */
    this.probe = function () { if (status === 'ready' && Date.now() - lastRx > 5000) ping(); };
    /* Wi-Fi back or app resumed: retry now if down (backoff reset), or prove the socket is alive if up */
    this.kick = function () {
      if (status === 'ready') { if (Date.now() - lastRx > 5000) ping(); return; }
      if (status === 'auth_invalid') return;
      attempt = 0;
      if (!ws) { clearTimeout(tRetry); connect(); }
    };
    this.callService = function (domain, service, data, target) {
      var msg = { type: 'call_service', domain: domain, service: service };
      if (data) msg.service_data = data;
      if (target) msg.target = target;
      return send(msg).promise;
    };
    /* key: a name for this subscription; msg: the subscribe_entities message; cb(event, fresh).
       Calling again with the same key replaces it (unsubscribing the old one). */
    this.subscribe = function (key, msg, cb) {
      var old = subs[key];
      if (old && old.wsId > 0 && status === 'ready') send({ type: 'unsubscribe_events', subscription: old.wsId }).promise.catch(function () {});
      if (!msg) { delete subs[key]; return; }
      var s = { key: key, msg: msg, cb: cb, wsId: -1, fresh: true };
      subs[key] = s;
      if (status === 'ready') open(s);
    };
  }

  /* Entity store fed by subscribe_entities events. Each subscription keeps its own map, so a
     re-subscription (or a reconnect) replaces exactly what it owns. */
  function EntityStore() {
    var maps = {};
    function apply(key, ev, fresh) {
      if (!ev || typeof ev !== 'object') return [];
      var m = maps[key];
      if (!m || (fresh && ev.a)) { m = maps[key] = {}; }
      var changed = [], id;
      if (ev.a) for (id in ev.a) {
        var cs = ev.a[id] || {};
        m[id] = { s: cs.s == null ? 'unknown' : String(cs.s), a: cs.a && typeof cs.a === 'object' ? copy(cs.a) : {}, lc: cs.lc, lu: cs.lu == null ? cs.lc : cs.lu };
        changed.push(id);
      }
      if (ev.c) for (id in ev.c) {
        var d = ev.c[id] || {}, e = m[id];
        if (!e) continue;                     // a diff for something we never saw: wait for the next full dump
        var add = d['+'] || {}, rem = d['-'] || {};
        if (add.s !== undefined) e.s = String(add.s);
        if (add.a && typeof add.a === 'object') { e.a = copy(e.a); for (var k in add.a) e.a[k] = add.a[k]; }
        if (rem.a && rem.a.length) { e.a = copy(e.a); rem.a.forEach(function (k) { delete e.a[k]; }); }
        if (add.lc !== undefined) { e.lc = add.lc; e.lu = add.lc; }
        if (add.lu !== undefined) e.lu = add.lu;
        changed.push(id);
      }
      if (ev.r) ev.r.forEach(function (rid) { if (m[rid]) { delete m[rid]; changed.push(rid); } });
      return changed;
    }
    function copy(o) { var r = {}; for (var k in o) r[k] = o[k]; return r; }
    this.apply = apply;
    this.get = function (id) { for (var k in maps) if (maps[k][id]) return maps[k][id]; return null; };
    this.ids = function (key) { return maps[key] ? Object.keys(maps[key]) : []; };
    this.drop = function (key) { delete maps[key]; };
  }

  window.HAClient = HAClient;
  window.EntityStore = EntityStore;
})();
