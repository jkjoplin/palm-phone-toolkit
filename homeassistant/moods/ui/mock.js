/* Palm Moods: mock mode. The five demo moods, as Home Assistant would serve them (the customize
   attributes from ha/packages/moods/), and an in-page socket backed by HouseSim (sim.js), so mock
   mode runs the very same client, parser, sky and confirmation code as a real connection.
   This is the ONLY place in ui/ (outside dev/) that names particular moods. */
(function () {
  'use strict';

  var DEMO = [
    { entity_id: 'script.mood_wind_down', alias: 'Mood: Wind Down', attributes: {
      mood: true, mood_slug: 'wind_down', mood_name: 'Wind Down', mood_tagline: 'Lamps low and warm. Diffuser on. Settle in.',
      mood_order: 10, mood_scope: 'Bedroom', mood_panels: ['bedroom'], mood_glyph: 'candle',
      mood_palette: { base: '#130905', glows: ['#d6742c', '#80341e', '#604670'], accent: '#f2a65e', ink: '#f8e8d4',
        sky: [['band', '#80341e', 0.38, 640, 300, 50, 30, 2], ['lamp', '#d6742c', 0.54, 640, 520, 50, 96, 1], ['glow', '#604670', 0.14, 380, 380, 94, 2, 3]] },
      mood_status: 'Diffuser on', mood_night: false, mood_holds_outdoor: false, mood_lights_outdoor: false,
      mood_touches: [{ label: 'Lights', entity: 'light.role_bedroom_lamps', expect: 'on' }, { label: 'Scent', entity: 'switch.role_diffuser', expect: 'on' }], icon: 'mdi:candle' } },
    { entity_id: 'script.mood_movie_night', alias: 'Mood: Movie Night', attributes: {
      mood: true, mood_slug: 'movie_night', mood_name: 'Movie Night', mood_tagline: 'TV on. One lamp, deep red. Everything else off.',
      mood_order: 20, mood_scope: 'Bedroom', mood_panels: ['bedroom'], mood_glyph: 'curtain',
      mood_palette: { base: '#0a0304', glows: ['#a81618', '#580a16', '#2e4684'], accent: '#e8574c', ink: '#f6e0da',
        sky: [['band', '#580a16', 0.5, 640, 320, 50, 36, 2], ['lamp', '#a81618', 0.62, 580, 480, 50, 100, 1], ['glow', '#2e4684', 0.26, 360, 360, 4, 4, 3]] },
      mood_status: 'TV on', mood_night: false, mood_holds_outdoor: false, mood_lights_outdoor: false,
      mood_touches: [{ label: 'Lights', entity: 'light.role_bedroom_movie_lamp', expect: 'on' }, { label: 'TV', entity: 'binary_sensor.role_bedroom_tv', expect: 'on' }] } },
    { entity_id: 'script.mood_afterglow', alias: 'Mood: Afterglow', attributes: {
      mood: true, mood_slug: 'afterglow', mood_name: 'Afterglow', mood_tagline: 'Loft and patio washed in colour. Stay a while.',
      mood_order: 30, mood_scope: 'House', mood_panels: ['bedroom'], mood_glyph: 'bulbs',
      mood_palette: { base: '#110716', glows: ['#ba387a', '#5c32a4', '#e67042'], accent: '#f4917c', ink: '#f8e4ec',
        sky: [['band', '#5c32a4', 0.46, 640, 320, 50, 20, 2], ['lamp', '#ba387a', 0.54, 620, 500, 50, 99, 1], ['glow', '#e67042', 0.26, 300, 300, 96, 72, 3]] },
      mood_status: 'Loft lights on', mood_night: false, mood_holds_outdoor: false, mood_lights_outdoor: true,
      mood_touches: [{ label: 'Loft', entity: 'light.role_loft_lamp', expect: 'on' }, { label: 'Patio', entity: 'light.role_patio_lights', expect: 'on' }] } },
    { entity_id: 'script.mood_lights_out', alias: 'Mood: Lights Out', attributes: {
      mood: true, mood_slug: 'lights_out', mood_name: 'Lights Out', mood_tagline: 'Lamps out, TV off. Bed cools. Sleep well.',
      mood_order: 40, mood_scope: 'House', mood_panels: ['bedroom'], mood_glyph: 'moon',
      mood_palette: { base: '#04050b', glows: ['#b05c28', '#242c64', '#143044'], accent: '#a9b6e6', ink: '#dfe3f2',
        sky: [['band', '#242c64', 0.56, 640, 380, 50, 22, 2], ['glow', '#143044', 0.4, 480, 480, 96, 64, 3], ['lamp', '#b05c28', 0.24, 320, 240, 50, 103, 1]] },
      mood_status: 'Bed cooling', mood_night: true, mood_holds_outdoor: false, mood_lights_outdoor: false,
      mood_touches: [{ label: 'Lights', entity: 'light.role_all_lights', expect: 'off' }, { label: 'Bed', entity: 'binary_sensor.role_bed', expect: 'on' }] } },
    { entity_id: 'script.mood_good_morning', alias: 'Mood: Good Morning', attributes: {
      mood: true, mood_slug: 'good_morning', mood_name: 'Good Morning', mood_tagline: 'Lamps rise to daylight. The loft wakes too.',
      mood_order: 50, mood_scope: 'House', mood_panels: ['bedroom'], mood_glyph: 'sunrise',
      mood_palette: { base: '#160e09', glows: ['#ea9840', '#546e96', '#f0be8c'], accent: '#f6c27c', ink: '#fcf0e2',
        sky: [['band', '#546e96', 0.4, 640, 300, 50, 10, 2], ['lamp', '#ea9840', 0.5, 660, 520, 50, 98, 1], ['glow', '#f0be8c', 0.12, 320, 320, 6, 54, 3]] },
      mood_status: 'Lamps rising', mood_night: false, mood_holds_outdoor: false, mood_lights_outdoor: false,
      mood_window: { from: '05:00', to: '11:00' },   // refused outside it, on the page's clock (?time= pins it)
      mood_touches: [{ label: 'Lights', entity: 'light.role_bedroom_lamps', expect: 'on' }] } }
  ];

  /* The five demo moods mirror their package files in ha/packages/moods/ attribute for attribute,
     including the approved mockup skies and inks (mood_palette.sky and .ink) with glows in the
     contract's order [lamp, band, counter-light], the approved card text, and Good Morning's time
     window. ui/dev/lint.js checks that both still agree. */

  /* ?mockset=many: twenty moods, several of them deliberately malformed, for layout and
     robustness checks. The broken ones must degrade (defaults) or be skipped, never break the deck. */
  function many() {
    var out = DEMO.slice();
    var names = ['Reading Nook', 'Rainy Afternoon', 'Bath Time', 'Storytime', 'Sunday Slow', 'Game Night', 'Dinner Party', 'Late Snack', 'Yoga', 'Nap', 'Cleaning Blitz', 'Stargazing'];
    var glyphs = ['desk_lamp', 'moon', 'candle', 'nonexistent_glyph', 'sunrise', 'glasses', 'glasses', 'key', '', 'moon', 'bulbs', 'moon'];
    var pals = [
      { base: '#0b1014', glows: ['#3aa0e6', '#2a7cab', '#f0dcb0'], accent: '#a8dcf6' },   // Focus without its sky (generated)
      { glows: ['#2f4766'] },                                     // one glow only
      { accent: '#f0b866' },                                      // accent only
      'not a palette',                                            // malformed
      { base: '#ffffff', glows: ['#ffffff', '#ffeecc', '#ccddff'], accent: '#ffffff' },   // far too bright
      { base: 'red', glows: 'blue', accent: 12 },                 // wrong types
      null,
      { base: '#140d07', glows: ['#c08a3e', '#7a2b2b', '#e0a458'], accent: '#f0b866' },
      { base: '#06080c', glows: ['#2f4766', '#1d2a38', '#8a5a2a'], accent: '#8fb3d9' },
      { base: '#000', glows: ['#123', '#456', '#789'], accent: '#abc' },
      { base: '#101808', glows: ['#5a8a2a', '#2a4a3a', '#a08a3a'], accent: '#c8e08a' },
      { base: '#03040a', glows: ['#1a2050', '#0a1830', '#6a5a9a'], accent: '#b0b8f0' }
    ];
    names.forEach(function (n, i) {
      var slug = n.toLowerCase().replace(/\s+/g, '_');
      out.push({ entity_id: 'script.mood_' + slug, alias: 'Mood: ' + n, attributes: {
        mood: true, mood_slug: slug, mood_name: i === 4 ? null : n,
        mood_tagline: i === 2 ? 42 : 'A made-up mood for testing, number ' + (i + 1) + '. It has a long tagline that should wrap tidily.',
        mood_order: i === 6 ? 'soon' : 100 + i * 10, mood_scope: i === 7 ? ['House'] : 'Somewhere',
        mood_panels: i % 3 ? 'bedroom' : ['office'], mood_glyph: glyphs[i], mood_palette: pals[i],
        mood_status: 'Test ' + (i + 1), mood_night: i === 11 ? 'true' : false,
        mood_touches: i === 3 ? 'Lights' : i === 5 ? [{ label: 'Bad', entity: 'not an entity', expect: 'on' }, { entity: 'light.role_office_lights', expect: true }, null, { label: 'Kitchen speakers', entity: 'media_player.role_kitchen_speaker', expect: 'playing' }, { label: 'Porch', entity: 'light.role_porch_lights', expect: 'on' }, { label: 'Fan', entity: 'switch.role_fan', expect: 'on' }]
          : [{ label: 'Lights', entity: 'light.role_office_lights', expect: 'on' }] } });
    });
    out.push({ entity_id: 'script.not_a_mood', attributes: { mood: false, mood_name: 'Hidden' } });
    out.push({ entity_id: 'script.mood_no_attrs', attributes: { mood: true } });                 // bare: name from the slug
    return out;
  }

  /* ?mockset=custom: the demo moods plus two custom mood slots made on the Moods dashboard (a slot
     script with mood_slot, its card the `card` attribute of sensor.moods_custom_<n>, as
     ui/dev/fixtures/custom-cards.json has them from Home Assistant), and placement for two demo moods:
     Movie Night "Not on the Bedroom Palm" (hidden on the default bedroom panel) and Good Morning at
     order 5 (first). Slot 1 "Reading" is ready; slot 2 "Dusk" is switched off, so it is not shown. */
  var READING = { mood: true, mood_slot: 1, mood_state: 'ready', mood_reason: '', mood_name: 'Reading', mood_tagline: 'Bedroom lamps soft white (2700 K), 40%.',
    mood_status: 'Bedroom lamps soft white (2700 K), 40%', mood_scope: 'Bedroom', mood_glyph: 'ember',
    mood_palette: { base: '#130905', glows: ['#d6742c', '#80341e', '#604670'], accent: '#f2a65e', ink: '#f8e8d4' }, mood_night: false, mood_window: null,
    mood_order: 110, mood_panels: [], mood_touches: [{ label: 'Lamps', entity: 'light.role_bedroom_lamps', expect: 'on' }], mood_lights_outdoor: false,
    mood_steps: [{ lights: 'Bedroom lamps', do: 'Soft white (2700 K)', pct: 40 }], mood_extras: { tv: null, scent: null, bed: null, others: 'leave', fade: 2 },
    mood_summary: 'Bedroom lamps soft white (2700 K), 40%', mood_problems: [] };
  var DUSK_OFF = { mood: false, mood_slot: 2, mood_state: 'not_ready', mood_reason: 'Dusk is switched off on the Moods dashboard.', mood_name: 'Dusk',
    mood_tagline: 'Loft amber and low. Diffuser on.', mood_status: 'Loft lamp amber, 30%', mood_scope: 'Loft', mood_glyph: 'candle',
    mood_palette: { base: '#110716', glows: ['#ba387a', '#5c32a4', '#e67042'], accent: '#f4917c', ink: '#f8e4ec' }, mood_night: false, mood_window: { from: '17:00', to: '23:00' },
    mood_order: 120, mood_panels: [], mood_touches: [{ label: 'Loft', entity: 'light.role_loft_lamp', expect: 'on' }, { label: 'Scent', entity: 'switch.role_diffuser', expect: 'on' }],
    mood_lights_outdoor: false, mood_steps: [{ lights: 'Loft lamp', do: 'Amber', pct: 30 }], mood_extras: { tv: null, scent: 'on', bed: null, others: 'indoor', fade: 2 },
    mood_summary: 'Loft lamp amber, 30%. Other indoor lights off. Diffuser on', mood_problems: [] };
  function custom() {
    return DEMO.concat([1, 2].map(function (n) {
      return { entity_id: 'script.mood_custom_' + n, alias: 'Mood: Custom ' + n, icon: 'mdi:palette-swatch-outline', attributes: { mood_slot: n, mood_holds_outdoor: false } };
    }));
  }
  function extras(set) {
    if (set !== 'custom') return [];
    return [
      { entity_id: 'sensor.moods_custom_1', state: 'ready', attributes: { card: READING, friendly_name: 'Reading' } },
      { entity_id: 'sensor.moods_custom_2', state: 'not_ready', attributes: { card: DUSK_OFF, friendly_name: 'Dusk (switched off)' } },
      { entity_id: 'input_select.moods_movie_night_where', state: 'Not on the Bedroom Palm', attributes: {} },
      { entity_id: 'input_number.moods_good_morning_order', state: '5', attributes: {} }
    ];
  }

  /* a WebSocket look-alike over HouseSim; messages are delivered asynchronously like a socket */
  function MockSocket(sim) {
    var s = this;
    this.readyState = 0;
    var conn = null;
    function deliver(obj) { var txt = JSON.stringify(obj); setTimeout(function () { if (s.readyState === 1 && s.onmessage) s.onmessage({ data: txt }); }, 0); }
    setTimeout(function () {
      s.readyState = 1;
      if (s.onopen) s.onopen({});
      conn = sim.connect(deliver);
      conn.onKill = function () { s.close(); };
    }, 30);
    this.send = function (txt) {
      if (s.readyState !== 1) throw new Error('not open');
      var msg = JSON.parse(txt);
      setTimeout(function () { if (conn) conn.receive(msg); }, 0);
    };
    this.close = function () {
      if (s.readyState === 3) return;
      s.readyState = 3;
      if (conn) conn.close();
      setTimeout(function () { if (s.onclose) s.onclose({ code: 1000 }); }, 0);
    };
  }

  window.MockHA = {
    moods: function (set) { return set === 'many' ? many() : set === 'custom' ? custom() : DEMO.slice(); },
    extras: extras,
    tempEntity: 'sensor.bedroom_temperature',
    never: 'light.role_patio_lights',      // Afterglow's patio never answers in the demo
    MockSocket: MockSocket
  };
})();
