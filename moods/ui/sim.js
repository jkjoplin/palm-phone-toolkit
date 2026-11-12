/* Palm Moods: a small simulated Home Assistant.
   Used by mock mode in the page (mock.js) and by the node fake server (dev/fake-ha.js),
   so both speak exactly the same subset of the WebSocket API:
     auth, supported_features, get_states, subscribe_entities (entity_ids and include/exclude),
     subscribe_events (state_changed), unsubscribe_events, call_service, ping.
   State changes go out the way HA 2026.11 sends them: subscribe_entities change events carry
   PARTIAL diffs ({"c":{id:{"+":{s?,a?:{changed keys},lc|lu,c},"-":{a:[removed]}}}}), so a client
   that replaces attributes instead of merging them breaks here just as it would on the real box.
   Classic script and CommonJS module (no ES modules: the page is loaded from file://). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HouseSim = factory();
})(this, function () {
  'use strict';

  var ENTITY_RE = /^(?!.+__)(?!_)[\da-z_]+(?<!_)\.(?!_)[\da-z_]+(?<!_)$/;

  function clone(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function nowTs() { return Date.now() / 1000; }
  function ctxId() { var s = ''; for (var i = 0; i < 26; i++) s += '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Math.floor(Math.random() * 32)]; return s; }
  function domainOf(id) { return String(id).split('.')[0]; }
  function globToRe(g) { return new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'); }

  /* HA's include/exclude filter (helpers/entityfilter.py), cases 1-4 for the shapes we use */
  function makeFilter(inc, exc) {
    inc = inc || {}; exc = exc || {};
    var iE = inc.entities || [], iD = inc.domains || [], iG = (inc.entity_globs || []).map(globToRe);
    var eE = exc.entities || [], eD = exc.domains || [], eG = (exc.entity_globs || []).map(globToRe);
    var haveInc = iE.length || iD.length || iG.length, haveExc = eE.length || eD.length || eG.length;
    function m(gs, id) { for (var i = 0; i < gs.length; i++) if (gs[i].test(id)) return true; return false; }
    if (!haveInc && !haveExc) return null;
    if (haveInc && !haveExc) return function (id) { return iE.indexOf(id) >= 0 || iD.indexOf(domainOf(id)) >= 0 || m(iG, id); };
    if (!haveInc && haveExc) return function (id) { return !(eE.indexOf(id) >= 0 || eD.indexOf(domainOf(id)) >= 0 || m(eG, id)); };
    return function (id) {
      return iE.indexOf(id) >= 0 || (eE.indexOf(id) < 0 && (m(iG, id) || (iD.indexOf(domainOf(id)) >= 0 && !m(eG, id))));
    };
  }

  function opposite(expect) {
    var e = String(expect).toLowerCase();
    if (e === 'on') return 'off';
    if (e === 'off') return 'on';
    if (e === 'playing') return 'idle';
    if (e === 'open') return 'closed';
    return 'off';
  }

  /* opts:
       moods: [{ entity_id, attributes, alias }]  (attributes = the customize block)
       token: string or null (null accepts any token)
       never: entity id that never answers ('' for none)
       initial: slug of the mood that is current at start, previous: slug
       speed: multiplier for delays (1 = realistic)
       tempEntity, temp: a temperature sensor (or a climate entity, whose current_temperature is set)
       clock: function returning a Date, the house's local time (default: the real clock). Only the
              mood time windows read it, so a test can pin it (fake-ha --clock, mock mode's ?time=)
       log: function(msg) */
  function HouseSim(opts) {
    opts = opts || {};
    var self = this;
    this.opts = opts;
    this.never = opts.never || '';
    this.speed = opts.speed == null ? 1 : opts.speed;
    this.calls = [];
    this.conns = [];
    this.states = {};
    this.timers = [];
    this.runs = {};
    this.moodIds = [];
    this.noop = {};
    this.log = opts.log || function () {};
    this.clock = typeof opts.clock === 'function' ? opts.clock : function () { return new Date(); };
    var t = nowTs();

    function put(id, s, a) { self.states[id] = { entity_id: id, state: s, attributes: a || {}, lc: t, lu: t, ctx: ctxId() }; }

    put('input_text.house_mood', opts.initial || '', { friendly_name: 'House mood', icon: 'mdi:palette-outline', mode: 'text', min: 0, max: 64, pattern: null });
    put('input_text.house_mood_previous', opts.previous || '', { friendly_name: 'House mood (previous)', icon: 'mdi:history', mode: 'text', min: 0, max: 64, pattern: null });
    put('input_text.house_mood_notice', '', { friendly_name: 'House mood notice', mode: 'text', min: 0, max: 255, pattern: null });
    put('input_boolean.vacation_mode', 'off', { friendly_name: 'Vacation mode' });
    put('script.mood_begin', 'off', { friendly_name: 'Moods: begin', mode: 'queued', current: 0, max: 10, last_triggered: null });
    put('script.mood_undo', 'off', { friendly_name: 'Moods: undo', mode: 'single', current: 0, last_triggered: null });
    put('script.some_other_script', 'off', { friendly_name: 'Unrelated script', mode: 'single', current: 0, last_triggered: null });
    if (opts.tempEntity && !/^climate\./.test(opts.tempEntity)) put(opts.tempEntity, String(opts.temp == null ? 68 : opts.temp), { friendly_name: 'Bedroom temperature', unit_of_measurement: '°F', device_class: 'temperature', state_class: 'measurement' });
    // a thermostat: its state is the HVAC mode and the room temperature is an attribute, so a
    // tempEntity pointing at a climate entity is exercised too
    put('climate.thermostat', 'heat_cool', { friendly_name: 'Thermostat', hvac_modes: ['off', 'heat', 'cool', 'heat_cool'], min_temp: 50, max_temp: 90,
      current_temperature: 71, target_temp_high: 76, target_temp_low: 68, preset_mode: 'none', preset_modes: ['none', 'eco'], supported_features: 402 });
    if (opts.tempEntity && /^climate\./.test(opts.tempEntity) && opts.tempEntity !== 'climate.thermostat') put(opts.tempEntity, 'heat_cool', { friendly_name: 'Thermostat', current_temperature: opts.temp == null ? 68 : opts.temp });
    // a little noise from the rest of the house, so filters are exercised
    put('sensor.kitchen_power', '120', { unit_of_measurement: 'W', friendly_name: 'Kitchen power' });
    put('light.office_ceiling_light', 'off', { friendly_name: 'Office ceiling light' });

    (opts.moods || []).forEach(function (m) {
      var a = clone(m.attributes) || {};
      a.friendly_name = m.alias || a.friendly_name || m.entity_id;
      a.mode = 'restart'; a.current = 0; a.last_triggered = null;
      if (a.icon == null && m.icon) a.icon = m.icon;
      put(m.entity_id, 'off', a);
      self.moodIds.push(m.entity_id);
    });

    // role entities named by touches start in the opposite of what any mood expects
    this.touchIndex = {};
    this.moodIds.forEach(function (id) {
      var ts = self.states[id].attributes.mood_touches;
      if (!Array.isArray(ts)) return;
      ts.forEach(function (tc) {
        if (!tc || typeof tc.entity !== 'string' || !ENTITY_RE.test(tc.entity)) return;
        if (!self.states[tc.entity]) put(tc.entity, opposite(tc.expect), { friendly_name: tc.entity.split('.')[1].replace(/_/g, ' ') });
      });
    });
    // light.role_all_lights is a group of the other light roles (not the guest room)
    this.groupMembers = {};
    if (this.states['light.role_all_lights']) {
      this.groupMembers['light.role_all_lights'] = Object.keys(this.states).filter(function (id) {
        return /^light\.role_/.test(id) && id !== 'light.role_all_lights' && !/guest_room/.test(id);
      });
    }
    // the initial mood's own touches are already satisfied
    var initId = opts.initial ? this.moodBySlug(opts.initial) : null;
    if (initId) this.touchesOf(initId).forEach(function (tc) { if (tc.entity !== self.never) self.setRaw(tc.entity, String(tc.expect)); });
    this.recomputeGroups(true);
  }

  HouseSim.ENTITY_RE = ENTITY_RE;
  HouseSim.makeFilter = makeFilter;

  /* A mood's time window (customize attribute mood_window: { from: "HH:MM", to: "HH:MM" }), the
     same rule as script.mood_begin in moods_core.yaml: local time, from inclusive, to exclusive,
     from later than to crosses midnight. 'none' (no attribute, or null), 'in', 'out', or 'bad'
     (not a map, a missing or non-HH:MM time, from equal to to): a bad window never blocks the
     mood, it runs as if it had none (HA logs a warning). lint.js uses this to reject a bad window
     in the package before deploy. */
  var HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  function windowState(w, date) {
    if (w == null) return { state: 'none' };
    if (typeof w !== 'object' || Array.isArray(w)) return { state: 'bad' };
    var f = w.from, t = w.to;
    if (typeof f !== 'string' || typeof t !== 'string' || !HHMM.test(f) || !HHMM.test(t) || f === t) return { state: 'bad' };
    var d = date || new Date();
    var hm = (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    var inside = f < t ? (f <= hm && hm < t) : (hm >= f || hm < t);
    return { state: inside ? 'in' : 'out', from: f, to: t };
  }
  HouseSim.windowState = windowState;
  /* the refusal text, as mood_begin words it: the mood_name, else the alias minus "Mood: ", else the slug */
  function moodName(st, slug) {
    var a = st.attributes || {};
    if (typeof a.mood_name === 'string' && a.mood_name.trim()) return a.mood_name.trim();
    if (typeof a.friendly_name === 'string' && a.friendly_name.trim()) return a.friendly_name.replace('Mood: ', '').trim();
    return slug.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  HouseSim.prototype.later = function (fn, ms) {
    var self = this;
    var h = setTimeout(function () { var i = self.timers.indexOf(h); if (i >= 0) self.timers.splice(i, 1); fn(); }, Math.max(0, ms * this.speed));
    this.timers.push(h);
    return h;
  };
  HouseSim.prototype.stop = function () { this.timers.forEach(clearTimeout); this.timers = []; };

  HouseSim.prototype.moodBySlug = function (slug) {
    // as the package: a mood is found by its script name (mood_undo runs script.mood_<previous>)
    var id = 'script.mood_' + slug;
    return this.moodIds.indexOf(id) >= 0 && this.states[id] ? id : null;
  };
  HouseSim.prototype.touchesOf = function (id) {
    var s = this.states[id], ts = s && s.attributes.mood_touches;
    if (!Array.isArray(ts)) return [];
    return ts.filter(function (tc) { return tc && typeof tc.entity === 'string' && ENTITY_RE.test(tc.entity); });
  };

  /* the temperature an entity reports: a sensor's state, or a climate entity's current_temperature */
  HouseSim.prototype.setTemp = function (id, v) {
    if (/^climate\./.test(id)) this.set(id, null, { current_temperature: Number(v) });
    else this.set(id, String(v));
  };

  /* set a state without emitting (construction only) */
  HouseSim.prototype.setRaw = function (id, s) { if (this.states[id]) this.states[id].state = s; };

  /* the one way state changes: builds old/new and tells every subscriber */
  HouseSim.prototype.set = function (id, s, attrPatch, removeKeys) {
    var old = this.states[id];
    var t = nowTs();
    var nu;
    if (!old) {
      nu = { entity_id: id, state: String(s), attributes: clone(attrPatch) || {}, lc: t, lu: t, ctx: ctxId() };
      this.states[id] = nu;
      this.emit(id, null, nu);
      return;
    }
    nu = clone(old);
    if (s != null) nu.state = String(s);
    if (attrPatch) for (var k in attrPatch) nu.attributes[k] = clone(attrPatch[k]);
    if (removeKeys) removeKeys.forEach(function (k) { delete nu.attributes[k]; });
    var same = nu.state === old.state && JSON.stringify(nu.attributes) === JSON.stringify(old.attributes);
    if (same) return;  // HA does not fire state_changed for an identical write
    nu.lu = t; if (nu.state !== old.state) nu.lc = t;
    nu.ctx = ctxId();
    this.states[id] = nu;
    this.emit(id, old, nu);
    if (/^light\./.test(id)) this.recomputeGroups();
  };
  HouseSim.prototype.remove = function (id) {
    var old = this.states[id]; if (!old) return;
    delete this.states[id];
    this.emit(id, old, null);
  };
  HouseSim.prototype.recomputeGroups = function (raw) {
    for (var g in this.groupMembers) {
      var self = this, any = this.groupMembers[g].some(function (m) { return self.states[m] && self.states[m].state === 'on'; });
      if (g === this.never) continue;
      if (raw) this.setRaw(g, any ? 'on' : 'off'); else if (this.states[g] && this.states[g].state !== (any ? 'on' : 'off')) this.set(g, any ? 'on' : 'off');
    }
  };

  HouseSim.prototype.emit = function (id, old, nu) {
    this.conns.forEach(function (c) { c.stateChanged(id, old, nu); });
  };

  function asDict(st) {
    return {
      entity_id: st.entity_id, state: st.state, attributes: clone(st.attributes),
      last_changed: new Date(st.lc * 1000).toISOString(), last_reported: new Date(st.lu * 1000).toISOString(),
      last_updated: new Date(st.lu * 1000).toISOString(), context: { id: st.ctx, parent_id: null, user_id: null }
    };
  }
  function compressed(st) {
    var o = { s: st.state, a: clone(st.attributes), c: st.ctx, lc: st.lc };
    if (st.lu !== st.lc) o.lu = st.lu;
    return o;
  }
  function diff(old, nu) {
    var add = {}, d = { '+': add };
    if (old.state !== nu.state) add.s = nu.state;
    if (old.lc !== nu.lc) add.lc = nu.lc; else if (old.lu !== nu.lu) add.lu = nu.lu;
    if (old.ctx !== nu.ctx) add.c = nu.ctx;
    var changed = {}, any = false, k;
    for (k in nu.attributes) if (!(k in old.attributes) || JSON.stringify(old.attributes[k]) !== JSON.stringify(nu.attributes[k])) { changed[k] = clone(nu.attributes[k]); any = true; }
    if (any) add.a = changed;
    var removed = [];
    for (k in old.attributes) if (!(k in nu.attributes)) removed.push(k);
    if (removed.length) d['-'] = { a: removed };
    return d;
  }

  /* ---------- moods: what the package's scripts do, roughly ---------- */
  HouseSim.prototype.delayFor = function (entity, j) {
    var d = domainOf(entity), base;
    if (d === 'light') base = 700 + Math.random() * 1100;
    else if (d === 'switch') base = 500 + Math.random() * 800;
    else if (d === 'binary_sensor') base = 1800 + Math.random() * 2200;
    else if (d === 'media_player') base = 1500 + Math.random() * 1500;
    else base = 1000;
    return base + j * 250;
  };

  HouseSim.prototype.runMood = function (id, why) {
    var self = this, st = this.states[id];
    if (!st) return;
    // the slug comes from the script's own entity id, as mood_begin's caller passes it
    // ({{ this.entity_id | replace('script.mood_', '') }}); mood_slug plays no part
    var slug = id.replace(/^script\.mood_/, '');
    var cur = this.states['input_text.house_mood'].state;
    this.log('mood ' + slug + ' (' + why + ')');
    var trig = new Date().toISOString();
    // mode: restart, as in HA: a new run of this mood stops its own earlier run before mood_begin
    // decides, so a re-tap that is then refused (vacation turned on, or a window that closed during
    // Good Morning's rise) still leaves the earlier run stopped where it was
    this.cancelRun(id);
    this.set(id, 'on', { last_triggered: trig, current: 1 });
    // a mood script that runs but never calls mood_begin (a file missing its first two steps):
    // HA runs it happily and house_mood never moves
    if (this.noop[id]) { this.later(function () { self.set(id, 'off', { current: 0 }); }, 300); return; }
    // mood_begin
    this.set('script.mood_begin', 'on', { last_triggered: trig, current: 1 });
    var vacation = this.states['input_boolean.vacation_mode'].state === 'on';
    // the window is read from this script's own attributes (found by entity id, never mood_slug)
    var win = windowState(st.attributes.mood_window, this.clock());
    function refuse(reason) {
      self.set('input_text.house_mood_notice', (slug + '|' + new Date().toISOString() + '|' + reason).slice(0, 255));
      self.set(id, 'off', { current: 0 });
    }
    this.later(function () {
      self.set('script.mood_begin', 'off', { current: 0 });
      // vacation first, then the mood's own time window
      if (vacation && slug !== 'away') { refuse('Vacation mode is on, so only Away can run.'); return; }
      if (win.state === 'bad') self.log(id + ' has a malformed mood_window (' + JSON.stringify(st.attributes.mood_window) + '); it runs as if it had no window');
      if (win.state === 'out') { refuse(moodName(st, slug) + ' only runs between ' + win.from + ' and ' + win.to + '.'); return; }
      // stop other running moods (Lights Out stops a slow Good Morning)
      self.moodIds.forEach(function (o) {
        if (o !== id && self.states[o] && self.states[o].state === 'on') { self.cancelRun(o); self.set(o, 'off', { current: 0 }); }
      });
      if (self.states['input_text.house_mood_notice'].state !== '') self.set('input_text.house_mood_notice', '');
      if (slug !== cur) {
        self.set('input_text.house_mood_previous', cur);
        self.set('input_text.house_mood', slug);
      }
      // the parallel block: each touched role reaches its state after a realistic delay
      self.cancelRun(id);
      var hs = [], last = 0;
      self.touchesOf(id).forEach(function (tc, j) {
        if (tc.entity === self.never) return;
        var ms = self.delayFor(tc.entity, j);
        last = Math.max(last, ms);
        hs.push(self.later(function () {
          var target = String(tc.expect);
          var members = self.groupMembers[tc.entity];
          if (members && (target === 'off' || target === 'on')) members.forEach(function (mm) { if (mm !== self.never) self.set(mm, target); });
          self.set(tc.entity, target);
        }, ms));
      });
      hs.push(self.later(function () { self.set(id, 'off', { current: 0 }); }, last + 300));
      self.runs[id] = hs;
    }, 120 + Math.random() * 150);
  };
  HouseSim.prototype.cancelRun = function (id) {
    var self = this;
    (this.runs[id] || []).forEach(function (h) { clearTimeout(h); var i = self.timers.indexOf(h); if (i >= 0) self.timers.splice(i, 1); });
    delete this.runs[id];
  };
  HouseSim.prototype.undo = function () {
    var self = this;
    this.set('script.mood_undo', 'on', { last_triggered: new Date().toISOString(), current: 1 });
    this.later(function () {
      self.set('script.mood_undo', 'off', { current: 0 });
      var prev = self.states['input_text.house_mood_previous'].state;
      var id = prev ? self.moodBySlug(prev) : null;
      if (id) self.runMood(id, 'undo');
    }, 80);
  };
  /* script.reload + reload_core_config: every mood script is removed, then created again from the
     (possibly changed) files. New touch entities appear in the house too. */
  HouseSim.prototype.reloadMoods = function (moods) {
    var self = this;
    this.moodIds.slice().forEach(function (id) { self.cancelRun(id); self.remove(id); });
    this.moodIds = [];
    var t = nowTs();
    (moods || []).forEach(function (m) {
      var a = clone(m.attributes) || {};
      a.friendly_name = m.alias || a.friendly_name || m.entity_id;
      a.mode = 'restart'; a.current = 0; a.last_triggered = null;
      if (a.icon == null && m.icon) a.icon = m.icon;
      self.moodIds.push(m.entity_id);
      self.set(m.entity_id, 'off', a);
      self.touchesOf(m.entity_id).forEach(function (tc) {
        if (!self.states[tc.entity]) self.set(tc.entity, opposite(tc.expect), { friendly_name: tc.entity.split('.')[1].replace(/_/g, ' ') });
      });
    });
    return this.moodIds.length;
  };

  /* something else (voice, the other phone, an automation) sets a mood */
  HouseSim.prototype.outside = function (slug) {
    var cur = this.states['input_text.house_mood'].state, id = slug ? this.moodBySlug(slug) : null;
    if (!id) {
      var others = this.moodIds.filter(function (m) { return m !== 'script.mood_' + cur; });
      id = others[Math.floor(Math.random() * others.length)];
    }
    if (id) this.runMood(id, 'outside');
    return id;
  };

  /* ---------- service calls ---------- */
  HouseSim.prototype.callService = function (domain, service, data, target) {
    data = data || {}; target = target || {};
    var ids = [].concat(target.entity_id || data.entity_id || []);
    this.calls.push({ t: Date.now(), domain: domain, service: service, entity_id: ids, data: clone(data) });
    if (this.calls.length > 200) this.calls.shift();
    var self = this;
    if (domain === 'script' && (service === 'turn_on' || service === 'toggle')) {
      // as HA (helpers/service.py): a target that does not exist is only logged ("Referenced
      // entities ... are missing or not currently available"); the call still succeeds
      var bad = ids.filter(function (id) { return !self.states[id] || domainOf(id) !== 'script'; });
      if (bad.length) self.log('Referenced entities ' + bad.join(', ') + ' are missing or not currently available');
      ids.forEach(function (id) {
        if (bad.indexOf(id) >= 0) return;
        if (id === 'script.mood_undo') self.undo();
        else if (self.moodIds.indexOf(id) >= 0) self.runMood(id, 'phone');
        else { self.set(id, 'on', { last_triggered: new Date().toISOString(), current: 1 }); self.later(function () { self.set(id, 'off', { current: 0 }); }, 300); }
      });
      return { result: { context: { id: ctxId(), parent_id: null, user_id: 'sim' }, response: null } };
    }
    if (domain === 'script' && service === 'mood_undo') { this.undo(); return { result: { context: { id: ctxId() }, response: null } }; }
    if (domain === 'script' && this.states['script.' + service] && this.moodIds.indexOf('script.' + service) >= 0) { this.runMood('script.' + service, 'phone'); return { result: { context: { id: ctxId() }, response: null } }; }
    if ((domain === 'light' || domain === 'switch' || domain === 'input_boolean') && (service === 'turn_on' || service === 'turn_off')) {
      ids.forEach(function (id) { if (self.states[id]) self.set(id, service === 'turn_on' ? 'on' : 'off'); });
      return { result: { context: { id: ctxId() }, response: null } };
    }
    return { error: { code: 'not_found', message: 'Action ' + domain + '.' + service + ' not found.' } };
  };

  /* ---------- one WebSocket connection: JSON objects in, JSON objects out ---------- */
  HouseSim.prototype.connect = function (send) {
    var sim = this;
    var c = {
      authed: false, subs: {}, closed: false, stalled: false,
      out: function (o) { if (!c.closed && !c.stalled) send(o); },
      close: function () { c.closed = true; var i = sim.conns.indexOf(c); if (i >= 0) sim.conns.splice(i, 1); },
      stateChanged: function (id, old, nu) {
        if (!c.authed) return;
        for (var k in c.subs) {
          var s = c.subs[k];
          if (s.kind === 'entities') {
            if (s.ids && s.ids.indexOf(id) < 0) continue;
            if (s.filter && !s.filter(id)) continue;
            var ev;
            if (!nu) ev = { r: [id] };
            else if (!old) { ev = { a: {} }; ev.a[id] = compressed(nu); }
            else { ev = { c: {} }; ev.c[id] = diff(old, nu); }
            c.out({ id: s.id, type: 'event', event: ev });
          } else if (s.kind === 'events' && (s.type === 'state_changed' || s.type == null)) {
            c.out({ id: s.id, type: 'event', event: { event_type: 'state_changed', data: { entity_id: id, old_state: old ? asDict(old) : null, new_state: nu ? asDict(nu) : null }, origin: 'LOCAL', time_fired: new Date().toISOString(), context: { id: ctxId() } } });
          }
        }
      },
      receive: function (msg) {
        if (c.closed) return;
        if (!c.authed) {
          if (msg && msg.type === 'auth') {
            var tok = msg.access_token;
            if (sim.opts.token != null && tok !== sim.opts.token) { c.out({ type: 'auth_invalid', message: 'Invalid access token or password' }); c.close(); if (c.onKill) c.onKill(); return; }
            c.authed = true;
            c.out({ type: 'auth_ok', ha_version: '2026.11.1' });
          } else { c.out({ type: 'auth_invalid', message: 'Auth message incorrectly formatted' }); c.close(); if (c.onKill) c.onKill(); }
          return;
        }
        var id = msg && msg.id;
        if (typeof id !== 'number') { c.out({ type: 'result', success: false, error: { code: 'invalid_format', message: 'Message incorrectly formatted.' } }); return; }
        function ok(r) { c.out({ id: id, type: 'result', success: true, result: r === undefined ? null : r }); }
        function err(code, m) { c.out({ id: id, type: 'result', success: false, error: { code: code, message: m } }); }
        switch (msg.type) {
          case 'ping': c.out({ id: id, type: 'pong' }); return;
          case 'supported_features': ok(null); return;
          case 'get_states': ok(Object.keys(sim.states).map(function (k) { return asDict(sim.states[k]); })); return;
          case 'subscribe_entities': {
            var ids = msg.entity_ids;
            if (ids != null && (!Array.isArray(ids) || ids.some(function (x) { return typeof x !== 'string' || !ENTITY_RE.test(x); }))) { err('invalid_format', 'Entity IDs are invalid'); return; }
            var inc = msg.include || {}, exc = msg.exclude || {};
            var incE = [].concat(inc.entities || []).concat(exc.entities || []);
            if (incE.some(function (x) { return typeof x !== 'string' || !ENTITY_RE.test(x); })) { err('invalid_format', 'Entity IDs are invalid'); return; }
            var s = { id: id, kind: 'entities', ids: ids && ids.length ? ids : null, filter: makeFilter(inc, exc) };
            c.subs[id] = s;
            ok(null);
            var a = {};
            Object.keys(sim.states).forEach(function (k) {
              if (s.ids && s.ids.indexOf(k) < 0) return;
              if (s.filter && !s.filter(k)) return;
              a[k] = compressed(sim.states[k]);
            });
            c.out({ id: id, type: 'event', event: { a: a } });
            return;
          }
          case 'subscribe_events': c.subs[id] = { id: id, kind: 'events', type: msg.event_type }; ok(null); return;
          case 'unsubscribe_events':
            if (c.subs[msg.subscription]) { delete c.subs[msg.subscription]; ok(null); } else err('not_found', 'Subscription not found.');
            return;
          case 'call_service': {
            var r = sim.callService(msg.domain, msg.service, msg.service_data, msg.target);
            if (r.error) err(r.error.code, r.error.message); else ok(r.result);
            return;
          }
          default: err('unknown_command', 'Unknown command.');
        }
      }
    };
    this.conns.push(c);
    send({ type: 'auth_required', ha_version: '2026.11.1' });
    return c;
  };

  return HouseSim;
});
