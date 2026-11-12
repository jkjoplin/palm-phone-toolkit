/* Palm Moods: turning Home Assistant attributes into moods, palettes and skies.
   Nothing here knows any particular mood. Every value is checked; anything missing or
   malformed falls back to a default or is skipped, so one bad attribute never breaks the deck.
   Classic script (no modules). Exposes window.Moods. */
(function () {
  'use strict';

  var ENTITY_RE = /^(?!.+__)(?!_)[\da-z_]+(?<!_)\.(?!_)[\da-z_]+(?<!_)$/;
  var SLUG_RE = /^[a-z0-9_]{1,64}$/;
  var HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
  var MAX_MOODS = 40, MAX_TOUCHES = 5;

  /* the house default: the Ember amber of Wind Down, used for missing palettes and the no-mood sky */
  var DEFAULT_PALETTE = { base: '#140a06', glows: ['#b4571e', '#8a3b2e', '#4a3f6a'], accent: '#f2a65e' };

  /* ---------- colour ---------- */
  function hex(c) {
    if (typeof c !== 'string') return null;
    c = c.trim();
    if (!HEX_RE.test(c)) return null;
    if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  }
  function toHex(c) { return '#' + c.map(function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
  function Y(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function scale(c, k) { return [c[0] * k, c[1] * k, c[2] * k]; }
  function rgba(c, a) { return 'rgba(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ',' + (Math.round(a * 1000) / 1000) + ')'; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  /* warm or cool: used to pick a counter-light when a palette gives fewer than three glows */
  function warm(c) { return c[0] >= c[2]; }

  /* A palette from HA: { base, glows: [lamp, band, counter], accent }. Any part may be missing or
     malformed; the rest is derived so the room still reads as lit by something. */
  function palette(p) {
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = null; } }
    if (!p || typeof p !== 'object') p = {};
    var accent = hex(p.accent), given = !!accent;
    var glowsIn = Array.isArray(p.glows) ? p.glows : (typeof p.glows === 'string' ? [p.glows] : []);
    var glows = glowsIn.map(hex).filter(Boolean).slice(0, 3);
    var base = hex(p.base);
    if (!accent && !glows.length) { accent = hex(DEFAULT_PALETTE.accent); given = true; glows = DEFAULT_PALETTE.glows.map(hex); if (!base) base = hex(DEFAULT_PALETTE.base); }
    if (!accent) accent = mix(glows[0], [255, 246, 236], 0.45);
    // the accent draws text, rings and marks: keep it readable on a dark room. A designer's own
    // accent is trusted down to Y 100 (Movie Night's red is about 117); a derived one is held to 135.
    var floor = given ? 100 : 135;
    for (var i = 0; i < 8 && Y(accent) < floor; i++) accent = mix(accent, [255, 244, 230], 0.18);
    if (!glows[0]) glows[0] = scale(accent, 0.72);
    if (!glows[1]) glows[1] = mix(glows[0], [40, 20, 30], 0.45);
    if (!glows[2]) glows[2] = warm(glows[0]) ? [74, 63, 106] : [138, 90, 42];
    if (!base) base = mix(scale(glows[0], 0.09), [10, 6, 5], 0.5);
    // a bright base would light the whole room: hold it to a dark plaster
    if (Y(base) > 26) base = scale(base, 26 / Y(base));
    // ink (clock, names): the mood's own cream if it gives one (mood_palette.ink), else a warm cream
    // tinted by the accent, kept between Y 170 (readable) and 235 (not glaring next to a bed).
    // A given ink is trusted between Y 150 and 248 (the mockup's Good Morning cream is about 241).
    var ink = hex(p.ink), lo = 150, hi = 248;
    if (!ink) { ink = mix([248, 236, 222], accent, 0.18); lo = 170; hi = 235; }
    for (i = 0; i < 8 && Y(ink) < lo; i++) ink = mix(ink, [255, 246, 236], 0.25);
    if (Y(ink) > hi) ink = scale(ink, hi / Y(ink));
    return { base: base, glows: glows, accent: accent, ink: ink, layers: skyLayers(p.sky) };
  }

  /* An explicit sky, when the mood gives one (mood_palette.sky): the mockup's hand-tuned form, one
     layer per entry, either [kind, "#rrggbb", alpha, width, height, x%, y%, drift] or
     { kind, color, alpha, w, h, x, y, drift }. kind is band, lamp or glow; sizes are in u (1/360 of
     the short side). Every value is clamped, so a typo can dim or move a glow but never light the
     room: alpha <= 0.62, and no layer may add more than Y 100 at its centre. Bad layers are dropped;
     with no good layer the sky is generated from the glows instead. */
  var KINDS = { band: 2, lamp: 1, glow: 3 };
  function num(v, lo, hi, d) { v = typeof v === 'string' ? parseFloat(v) : v; return typeof v === 'number' && isFinite(v) ? clamp(v, lo, hi) : d; }
  function skyLayers(s) {
    if (!Array.isArray(s)) return null;
    var out = [];
    s.slice(0, 4).forEach(function (g) {
      var L = null;
      if (Array.isArray(g)) L = { kind: g[0], color: g[1], alpha: g[2], w: g[3], h: g[4], x: g[5], y: g[6], drift: g[7] };
      else if (g && typeof g === 'object') L = { kind: g.kind, color: g.color, alpha: g.alpha, w: g.w, h: g.h, x: g.x, y: g.y, drift: g.drift };
      if (!L || !Object.prototype.hasOwnProperty.call(KINDS, L.kind)) return;
      var c = hex(L.color), a = num(L.alpha, 0, 0.62, null);
      if (!c || a == null) return;
      if (a * Y(c) > 100) a = 100 / Y(c);
      out.push([L.kind, c, a, num(L.w, 40, 900, 400), num(L.h, 40, 900, 400), num(L.x, -30, 130, 50), num(L.y, -30, 130, 50),
                Math.round(num(L.drift, 1, 3, KINDS[L.kind]))]);
    });
    return out.length ? out : null;
  }

  /* hash for stable per-mood variety (FNV-1a; its low bits are poor for short slugs, so use the high ones) */
  function hash(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; } return h; }
  function chroma(c) { return Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]); }

  /* The Ember sky for ANY palette (used when the mood gives no explicit sky): a dominant low lamp
     (glows[0]) behind the lower centre, a broad soft horizontal band (glows[1]) high on the wall,
     and a faint counter-light (glows[2]) in one corner. Alpha comes from each colour's luminance,
     so pale palettes stay dim: no broad area should rise much above Y 90/255 next to a bed.
     slot: the mood's place in the deck, so neighbouring cards put the counter-light in different
     corners (as the mockup did). A night mood gets a small, faint lamp: an ember, not a glow.
     A grey counter-light (no colour, about as dark as the room) would only haze the room: skipped.
     Returns layers [kind, rgb, alpha, width(u), height(u), x%, y%, drift] */
  var CORNERS = [[94, 4, 380], [6, 6, 360], [96, 70, 320], [5, 58, 330]];
  function sky(pal, slug, night, slot) {
    if (pal.layers) return pal.layers;
    var k = night ? 0.78 : 1, h = hash(slug) >>> 8;
    var lamp = pal.glows[0], band = pal.glows[1], counter = pal.glows[2];
    var c = CORNERS[(slot == null ? (hash(slug) >>> 16) : slot) % CORNERS.length];
    var bandY = 14 + (h % 19), bandH = 300 + ((h >>> 5) % 5) * 20, lampW = 580 + ((h >>> 9) % 5) * 20;
    var out = [['band', band, clamp(28 * k / Math.max(1, Y(band)), 0.12, 0.56), 640, bandH, 50, bandY, 2]];
    if (night) out.push(['lamp', lamp, clamp(22 / Math.max(1, Y(lamp)), 0.08, 0.26), 320, 240, 50, 103, 1]);
    else out.push(['lamp', lamp, clamp(58 / Math.max(1, Y(lamp)), 0.2, 0.62), lampW, 520, 50, 97, 1]);
    var grey = chroma(counter) < 20 && Math.abs(Y(counter) - Y(pal.base)) < 60;
    if (!grey) out.push(['glow', counter, clamp(20 * k / Math.max(1, Y(counter)), 0.06, 0.4), c[2], c[2], c[0], c[1], 3]);
    return out;
  }
  function layerBackground(kind, c, a) {
    if (kind === 'band') {
      return 'linear-gradient(to bottom,' + rgba(c, 0) + ' 0%,' + rgba(c, a * .4) + ' 18%,' + rgba(c, a * .82) + ' 34%,' + rgba(c, a) + ' 50%,' +
        rgba(c, a * .82) + ' 66%,' + rgba(c, a * .4) + ' 82%,' + rgba(c, 0) + ' 100%)';
    }
    return 'radial-gradient(closest-side,' + rgba(c, a) + ' 0%,' + rgba(c, a * .76) + ' 20%,' + rgba(c, a * .46) + ' 42%,' +
      rgba(c, a * .2) + ' 66%,' + rgba(c, a * .06) + ' 86%,' + rgba(c, 0) + ' 100%)';
  }

  /* ---------- attributes -> mood ---------- */
  /* the index just after the first k characters of v, counted as Home Assistant counts them (code
     points: an emoji is one, not two), so a cut never splits a surrogate pair */
  function cpCut(v, k) {
    var i = 0, n = 0, c;
    while (i < v.length && n < k) {
      c = v.charCodeAt(i);
      i += (c >= 0xD800 && c <= 0xDBFF && i + 1 < v.length && (v.charCodeAt(i + 1) & 0xFC00) === 0xDC00) ? 2 : 1;
      n++;
    }
    return i;
  }
  function str(v, max) {
    if (typeof v === 'number' && isFinite(v)) v = String(v);
    if (typeof v !== 'string') return '';
    v = v.replace(/\s+/g, ' ').trim();
    return cpCut(v, max) < v.length ? v.slice(0, cpCut(v, max - 1)).trim() + '…' : v;
  }
  function truthy(v) { return v === true || v === 'true' || v === 'True' || v === 1; }
  function titleCase(s) { return s.replace(/_/g, ' ').replace(/\b[a-z]/g, function (m) { return m.toUpperCase(); }); }
  function expectStr(v) {
    if (v === true) return 'on';           // YAML 1.1: an unquoted on/yes is a boolean
    if (v === false) return 'off';
    if (typeof v === 'number' && isFinite(v)) return String(v);
    if (typeof v !== 'string' || !v.trim()) return null;
    return v.trim().toLowerCase();
  }

  /* A custom mood slot (made on the Moods dashboard): its script carries mood_slot (and no mood
     key), and its card is the `card` attribute of sensor.moods_custom_<n>. The card's mood keys are
     read like customize attributes, and only those keys; its touches must be role entities. */
  var MOOD_KEYS = ['mood_name', 'mood_tagline', 'mood_status', 'mood_scope', 'mood_glyph', 'mood_palette', 'mood_night', 'mood_order', 'mood_panels', 'mood_touches'];
  var ROLE_RE = /^(light|switch|binary_sensor)\.role_[a-z0-9_]+$/;
  function plain(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function slotAttrs(entityId, attrs, card) {
    var n = attrs.mood_slot;
    if (typeof n !== 'number' || n !== Math.floor(n) || n < 1 || n > 9) return null;
    if (entityId !== 'script.mood_custom_' + n) return null;
    if (!plain(card) || card.mood !== true || Number(card.mood_slot) !== n) return null;
    var a = { friendly_name: '' };
    MOOD_KEYS.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(card, k)) a[k] = card[k]; });
    a.mood = true;
    var t = a.mood_touches;
    if (plain(t)) t = [t];
    a.mood_touches = Array.isArray(t) ? t.filter(function (x) { return plain(x) && typeof x.entity === 'string' && ROLE_RE.test(x.entity.trim()); }) : [];
    return a;
  }

  /* returns a mood object, or null to skip the entity. card: a slot's card (custom moods only) */
  function parse(entityId, attrs, card) {
    if (typeof entityId !== 'string' || !/^script\./.test(entityId) || !ENTITY_RE.test(entityId)) return null;
    if (!attrs || typeof attrs !== 'object') return null;
    var slot = 0;
    if (!truthy(attrs.mood)) {
      attrs = slotAttrs(entityId, attrs, card);
      if (!attrs) return null;
      slot = Number(card.mood_slot);
    }
    // The slug is the script's own name after mood_, exactly as the package writes house_mood
    // (mood_begin takes it from this.entity_id). mood_slug is only a cross-check: a file copied
    // from another mood that kept the old mood_slug must still be its own mood.
    var slug = entityId.replace(/^script\./, '').replace(/^mood_/, '');
    var said = typeof attrs.mood_slug === 'string' ? attrs.mood_slug.trim().toLowerCase() : '';
    var name = str(attrs.mood_name, 32);
    if (!name) name = str(String(attrs.friendly_name || '').replace(/^mood:\s*/i, ''), 32) || titleCase(slug);
    var order = Number(attrs.mood_order);
    if (!isFinite(order)) order = 1000;
    var panels = attrs.mood_panels;
    if (typeof panels === 'string') panels = panels.split(',');
    panels = Array.isArray(panels) ? panels.map(function (p) { return str(p, 40).toLowerCase(); }).filter(Boolean) : [];
    var touches = [];
    var tIn = attrs.mood_touches;
    if (tIn && !Array.isArray(tIn) && typeof tIn === 'object') tIn = [tIn];
    if (Array.isArray(tIn)) {
      tIn.forEach(function (t) {
        if (touches.length >= MAX_TOUCHES || !t || typeof t !== 'object') return;
        var ent = typeof t.entity === 'string' ? t.entity.trim() : '';
        var exp = expectStr(t.expect);
        if (!ENTITY_RE.test(ent) || exp == null) return;
        var label = str(t.label, 16) || titleCase(ent.split('.')[0]);
        touches.push({ label: label, entity: ent, expect: exp });
      });
    }
    var pal = palette(attrs.mood_palette);
    var night = truthy(attrs.mood_night);
    return {
      id: entityId, slug: slug, name: name, slugMismatch: said && said !== slug ? said : '', slot: slot,
      tagline: str(attrs.mood_tagline, 120),
      order: order, scope: str(attrs.mood_scope, 24), panels: panels,
      glyph: str(attrs.mood_glyph, 40), status: str(attrs.mood_status, 40),
      night: night, touches: touches, pal: pal, sky: sky(pal, slug, night)
    };
  }

  /* a panel name as a key, the way the panel settings ids are built (Living room -> living_room) */
  function panelKey(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 32); }
  /* "Where it shows" (input_select.moods_<slug>_where), matched by exact text, for the panel with key
     pkey: 'first' (before everything), 'panel' (with this panel's moods), 'hide', or '' (the usual
     mood_panels rule: the first option, missing, unknown, or any other text) */
  var PLACE_RE = /^(Only on|Not on) the (.+) Palm$/;
  function placeRule(where, pkey) {
    if (typeof where !== 'string') return '';
    if (where === 'First on every phone') return 'first';
    if (where === 'Hidden on every phone') return 'hide';
    var m = PLACE_RE.exec(where);
    if (!m) return '';
    var here = panelKey(m[2]) === pkey && pkey !== '';
    if (m[1] === 'Only on') return here ? 'panel' : 'hide';
    return here ? 'hide' : '';
  }
  /* "Order in the deck" (input_number.moods_<slug>_order): a number from 1 to 999 replaces mood_order;
     0 (usual), anything else or nothing keeps it */
  function placeOrder(v) {
    if (typeof v === 'string') v = v.trim() === '' ? NaN : Number(v);
    return typeof v === 'number' && isFinite(v) && v >= 1 && v <= 999 ? v : null;
  }

  /* every mood (scripts with mood: true, and ready custom mood slots), sorted: first-on-every-phone,
     then this panel's moods, then the rest; within each by mood_order, then name.
     opts (optional; without it this is the 0.1.0 deck):
       card(n)     the card of slot n (an object), or null
       place(slug) { where, order }: the mood's placement helpers' states
       current     the slug (or slugs) the house has now: never dropped by hiding (sorted last, hiddenHere)
     Hiding that would leave no mood is ignored (the returned list has hidingIgnored = true).
     The returned list has hid = how many moods placement hid here (dropped or kept as hiddenHere). */
  function fromStates(get, ids, panel, opts) {
    opts = opts || {};
    var out = [], seen = {};
    ids.forEach(function (id) {
      var st = get(id);
      var m = null;
      try {
        var a = st ? st.a : null, card = null;
        if (a && typeof a === 'object' && !truthy(a.mood) && a.mood_slot != null && typeof opts.card === 'function') card = opts.card(Number(a.mood_slot));
        m = a ? parse(id, a, card) : null;
      } catch (e) { m = null; }
      if (!m || seen[m.id]) return;
      seen[m.id] = 1;
      out.push(m);
    });
    panel = String(panel || '').toLowerCase();
    var pkey = panelKey(panel);
    var keep = [].concat(opts.current == null ? [] : opts.current).map(function (s) { return String(s); });
    var shown = 0;
    out.forEach(function (m) {
      var p = null;
      if (typeof opts.place === 'function') { try { p = opts.place(m.slug); } catch (e) { p = null; } }
      var rule = p && typeof p === 'object' ? placeRule(p.where, pkey) : '';
      var o = p && typeof p === 'object' ? placeOrder(p.order) : null;
      if (o != null) m.order = o;
      m.usual = m.panels.indexOf(panel) >= 0 ? 0 : 1;
      m.group = rule === 'first' ? -1 : rule === 'panel' ? 0 : m.usual;
      m.hide = rule === 'hide';
      m.hiddenHere = false;
      if (!m.hide) shown++;
    });
    var hid = 0, ignored = false;
    if (shown === 0 && out.length) ignored = true;     // hiding every mood: ignore hiding here
    else {
      out = out.filter(function (m) {
        if (!m.hide) return true;
        hid++;
        if (keep.indexOf(m.slug) < 0) return false;
        m.hiddenHere = true; m.group = 2;                // the current mood stays, last, so the face tells the truth
        return true;
      });
    }
    out.sort(function (a, b) {
      if (a.group !== b.group) return a.group - b.group;
      if (a.order !== b.order) return a.order - b.order;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    if (out.length > MAX_MOODS) {
      var cut = out.slice(MAX_MOODS).filter(function (m) { return m.hiddenHere; });
      out = out.slice(0, MAX_MOODS - cut.length).concat(cut);
    }
    out.forEach(function (m) { delete m.usual; delete m.group; delete m.hide; });
    out.hid = hid;
    out.hidingIgnored = ignored;
    // generated skies take their counter-light corner from their place in the deck
    out.forEach(function (m, i) { m.sky = sky(m.pal, m.slug, m.night, i); });
    return out;
  }

  /* signature: rebuild the deck only when something visible changed */
  function signature(list) {
    return JSON.stringify(list.map(function (m) {
      return [m.id, m.slug, m.name, m.tagline, m.scope, m.glyph, m.status, m.night, !!m.hiddenHere, m.touches, toHex(m.pal.base), toHex(m.pal.accent), toHex(m.pal.ink),
        m.sky.map(function (g) { return [g[0], toHex(g[1])].concat(g.slice(2).map(function (v) { return Math.round(v * 1000) / 1000; })); })];
    }));
  }

  window.Moods = {
    ENTITY_RE: ENTITY_RE, DEFAULT_PALETTE: DEFAULT_PALETTE,
    parse: parse, fromStates: fromStates, signature: signature, placeRule: placeRule, placeOrder: placeOrder, panelKey: panelKey,
    palette: palette, sky: sky, layerBackground: layerBackground,
    hex: hex, toHex: toHex, rgba: rgba, mix: mix, Y: Y
  };
})();
