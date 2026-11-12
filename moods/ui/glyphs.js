/* Palm Moods: the glyph set.
   A mood names a glyph with mood_glyph. Keys are looked up here; an unknown or missing key
   falls back to the neutral "ember" glyph, so a new mood never breaks the deck.
   Each glyph: h = [cx, cy, r] a soft halo centred on the glyph's own light source,
               d = SVG paths in a 64x64 box, drawn with a 1.15 hairline (see .gs in ember.css).
   To add one: draw it in a 64x64 box with round caps, add it below, and use its key in the
   mood's YAML. Keep the light source (flame, bulb, shade mouth) where the halo is. */
(function () {
  'use strict';
  var G = {
    candle: { h: [32, 17, 16], d: '<path d="M32 25.5c-3.7-3.3-4.2-8.1 0-14 4.2 5.9 3.7 10.7 0 14z"/><path d="M32 25.5v3.5"/><path d="M25 29.5h14v24a1.6 1.6 0 0 1-1.6 1.6H26.6A1.6 1.6 0 0 1 25 53.5z"/><path d="M35.5 29.5v6a1.2 1.2 0 0 0 2.4 0v-2"/><path d="M18 58.5h28"/>' },
    curtain: { h: [32, 35, 15], d: '<path d="M7 10.5h50"/><path d="M8 10.5q6 6.5 12 0q6 6.5 12 0q6 6.5 12 0q6 6.5 12 0"/><path d="M10 14v42"/><path d="M10 14c0 15 3 30 13 42"/><path d="M15.5 40.5l4 1.5"/><path d="M54 14v42"/><path d="M54 14c0 15-3 30-13 42"/><path d="M48.5 40.5l-4 1.5"/><path d="M29.2 31.5h5.6l1.7 4.5h-9z"/><path d="M32 36v5.5M29.3 41.5h5.4"/>' },
    /* a sagging string of bistro bulbs over a slow wave */
    bulbs: { h: [32, 30, 25], d: '<path d="M4 13.5Q32 38 60 13.5"/>' +
      '<path d="M15.2 21.6v2.6"/><path d="M15.2 24.2c-2.6 0-3.4 2.2-3.4 3.6a3.4 3.4 0 0 0 6.8 0c0-1.4-.8-3.6-3.4-3.6z"/>' +
      '<path d="M26.4 25.4v2.6"/><path d="M26.4 28c-2.6 0-3.4 2.2-3.4 3.6a3.4 3.4 0 0 0 6.8 0c0-1.4-.8-3.6-3.4-3.6z"/>' +
      '<path d="M37.6 25.4v2.6"/><path d="M37.6 28c-2.6 0-3.4 2.2-3.4 3.6a3.4 3.4 0 0 0 6.8 0c0-1.4-.8-3.6-3.4-3.6z"/>' +
      '<path d="M48.8 21.6v2.6"/><path d="M48.8 24.2c-2.6 0-3.4 2.2-3.4 3.6a3.4 3.4 0 0 0 6.8 0c0-1.4-.8-3.6-3.4-3.6z"/>' +
      '<path d="M11 52c4.5-3.4 9-3.4 13.5 0s9 3.4 13.5 0 9-3.4 13.5 0"/>' },
    moon: { h: [36, 30, 22], d: '<path d="M40 13A19.5 19.5 0 1 0 51.5 42 16 16 0 0 1 40 13z"/><path d="M16 12v7M12.5 15.5h7"/><circle class="dot" cx="51" cy="18" r="1"/><circle class="dot" cx="20" cy="52" r=".9"/><circle class="dot" cx="55" cy="31" r=".7"/>' },
    sunrise: { h: [32, 44, 19], d: '<path d="M20 44a12 12 0 0 1 24 0"/><path d="M5 44h54"/><path d="M32 21.5v7"/><path d="M15.7 27.7l5 5"/><path d="M48.3 27.7l-5 5"/><path d="M9.6 38.2l6.8 1.8"/><path d="M54.4 38.2l-6.8 1.8"/><path d="M15 50.5h34"/><path d="M23 56.5h18"/>' },
    /* an architect's lamp over a desk: Focus */
    desk_lamp: { h: [40, 31, 16], d: '<path d="M14 56.5h36"/><path d="M21.5 56.5c0-2.4 2.4-3.8 5.5-3.8s5.5 1.4 5.5 3.8"/><path d="M27 52.7 20.5 37.5 33.6 20.2"/><circle cx="20.5" cy="37.5" r="1.7"/><path d="M33.2 16.4 49.6 22.9 Q43.4 31.6 33.6 27.6 Q28.8 21.4 33.2 16.4z"/><circle class="dot" cx="42.2" cy="29.9" r="1.1"/><path d="M38 56.5v-3.2h12.5v3.2"/>' },
    /* two glasses meeting in a toast: Hosting. Drawn 6 lower than the toast's own frame, so the
       feet stand on the shelf line; the feet are short enough not to cross between the stems. */
    glasses: { h: [32, 18, 15], d: '<g transform="translate(0 6)"><g transform="rotate(-13 23 31)"><path d="M16 12.5h14c0 9.5-2.6 16.5-7 16.5s-7-7-7-16.5z"/><path d="M17.2 19h11.6"/><path d="M23 29v16.5"/><path d="M18.6 46h8.8"/></g>' +
      '<g transform="rotate(13 41 31)"><path d="M34 12.5h14c0 9.5-2.6 16.5-7 16.5s-7-7-7-16.5z"/><path d="M35.2 19h11.6"/><path d="M41 29v16.5"/><path d="M36.6 46h8.8"/></g>' +
      '<path d="M32 3.5v3.6M26.8 5.2l1.9 2.6M37.2 5.2l-1.9 2.6"/></g><path d="M14 53.6h36"/>' },
    /* a door key with its paper tag on a short string: Away */
    key: { h: [21, 21, 15], d: '<circle cx="21" cy="21" r="9.5"/><circle cx="18.6" cy="18.6" r="2.6"/><path d="M27.8 27.8 50.5 50.5"/><path d="M42.3 42.3l-4.4 4.4M46.6 46.6l-3.3 3.3"/><path d="M38.3 38.3l-2.6 2.6"/>' +
      '<path d="M14.3 27.7c-1.2 2-2.4 3.4-3.8 4.6"/><path d="M6.6 33.6l4.6-2.4 5.2 10-4.6 2.4a1.2 1.2 0 0 1-1.6-.5L6.1 35.2a1.2 1.2 0 0 1 .5-1.6z"/><circle class="dot" cx="10.4" cy="33.9" r=".8"/>' },
    /* neutral fallback: a small flame inside a lamp ring */
    ember: { h: [32, 34, 17], d: '<circle cx="32" cy="34" r="15.5"/><path d="M32 42c-3.4-2.8-3.8-7 0-12.2 3.8 5.2 3.4 9.4 0 12.2z"/><path d="M20 58.5h24"/>' }
  };
  var ALIAS = { flame: 'candle', movie: 'curtain', tv: 'curtain', party: 'glasses', drinks: 'glasses', lights: 'bulbs', string_lights: 'bulbs',
                night: 'moon', sleep: 'moon', sun: 'sunrise', morning: 'sunrise', lamp: 'desk_lamp', desk: 'desk_lamp', office: 'desk_lamp',
                away: 'key', leave: 'key', home: 'key' };

  function norm(k) { return String(k == null ? '' : k).toLowerCase().replace(/^mdi:/, '').replace(/[-\s]+/g, '_'); }
  function get(key) {
    var k = norm(key);
    if (Object.prototype.hasOwnProperty.call(G, k)) return G[k];
    if (Object.prototype.hasOwnProperty.call(ALIAS, k)) return G[ALIAS[k]];
    return G.ember;
  }
  var gid = 0;
  function svg(key, cls) {
    var g = get(key), id = 'eh' + (gid++), h = g.h;
    return '<svg class="gs ' + (cls || '') + '" viewBox="0 0 64 64" aria-hidden="true">' +
      '<defs><radialGradient id="' + id + '"><stop offset="0" stop-color="currentColor" stop-opacity=".2"/><stop offset=".45" stop-color="currentColor" stop-opacity=".08"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></radialGradient></defs>' +
      '<circle cx="' + h[0] + '" cy="' + h[1] + '" r="' + h[2] + '" fill="url(#' + id + ')" stroke="none"/>' + g.d + '</svg>';
  }
  window.Glyphs = { svg: svg, has: function (k) { return get(k) !== G.ember || norm(k) === 'ember'; }, keys: Object.keys(G) };
})();
