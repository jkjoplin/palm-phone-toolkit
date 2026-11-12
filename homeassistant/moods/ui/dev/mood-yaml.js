/* A small, purpose-built YAML reader for the moods package (ha/packages/moods/*.yaml).
   It reads only what the fake Home Assistant needs:
     - the top-level `input_select:` section (the settings helpers in moods_settings.yaml),
     - the top-level `homeassistant:` section (customize attributes: block maps, block sequences,
       flow maps and sequences, quoted and plain scalars, YAML 1.1 booleans, comments), and
     - each script's `alias:` and `icon:` under the top-level `script:` section.
   It is not a general YAML parser. `node mood-yaml.js <file>...` prints what it read as JSON;
   `node mood-yaml.js --check [dir]` compares it with PyYAML (via uv) for every file (default dir: ha/packages/moods). */
'use strict';
const fs = require('fs');
const path = require('path');

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '\\' && q === '"') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).replace(/\s+$/, '');
  }
  return line.replace(/\s+$/, '');
}

function scalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s[0] === '[' || s[0] === '{') { const r = flow(s, 0); return r.v; }
  if (s[0] === '"' || s[0] === "'") return quoted(s, 0).v;
  if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON)$/.test(s)) return true;
  if (/^(false|False|FALSE|no|No|NO|off|Off|OFF)$/.test(s)) return false;
  // YAML 1.1 base-60 integers, as PyYAML (and so HA) reads them: an unquoted 11:00 is 660, while
  // 05:00 (leading zero) stays a string. Mirrored so lint sees what HA sees in mood_window.
  if (/^[-+]?[1-9][0-9_]*(:[0-5]?[0-9])+$/.test(s)) { const neg = s[0] === '-'; const v = s.replace(/^[-+]/, '').replace(/_/g, '').split(':').reduce((acc, x) => acc * 60 + parseInt(x, 10), 0); return neg ? -v : v; }
  if (/^[-+]?\d+$/.test(s)) return parseInt(s, 10);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return parseFloat(s);
  return s;
}

function quoted(s, i) {
  const q = s[i]; let out = ''; i++;
  while (i < s.length) {
    const c = s[i];
    if (q === '"' && c === '\\') { const n = s[i + 1]; out += n === 'n' ? '\n' : n === 't' ? '\t' : n; i += 2; continue; }
    if (c === q) { if (q === "'" && s[i + 1] === "'") { out += "'"; i += 2; continue; } return { v: out, i: i + 1 }; }
    out += c; i++;
  }
  throw new Error('unterminated string: ' + s);
}

function flow(s, i) {
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function value() {
    ws();
    const c = s[i];
    if (c === '[') {
      i++; const a = [];
      for (;;) { ws(); if (s[i] === ']') { i++; return a; } a.push(value()); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === ']') { i++; return a; } throw new Error('bad flow seq: ' + s); }
    }
    if (c === '{') {
      i++; const o = {};
      for (;;) {
        ws(); if (s[i] === '}') { i++; return o; }
        let k;
        if (s[i] === '"' || s[i] === "'") { const r = quoted(s, i); k = r.v; i = r.i; ws(); }
        else { const st = i; while (i < s.length && s[i] !== ':') i++; k = s.slice(st, i).trim(); }
        if (s[i] !== ':') throw new Error('bad flow map: ' + s);
        i++;
        o[k] = value(); ws();
        if (s[i] === ',') { i++; continue; } if (s[i] === '}') { i++; return o; }
        throw new Error('bad flow map: ' + s);
      }
    }
    if (c === '"' || c === "'") { const r = quoted(s, i); i = r.i; return r.v; }
    const st = i;
    while (i < s.length && s[i] !== ',' && s[i] !== ']' && s[i] !== '}') i++;
    return scalar(s.slice(st, i));
  }
  const v = value();
  return { v, i };
}

/* lines -> [{ind, text}] without comments or blanks */
function lex(text) {
  return text.split(/\r?\n/).map(stripComment).filter((l) => l.trim() !== '').map((l) => ({ ind: l.match(/^ */)[0].length, text: l.trim() }));
}

function keyVal(t) {
  let k, rest;
  if (t[0] === '"' || t[0] === "'") { const r = quoted(t, 0); k = r.v; rest = t.slice(r.i).replace(/^\s*:/, ''); }
  else { const m = /^([^:]+?):(\s+|$)(.*)$/.exec(t); if (!m) return null; k = m[1].trim(); rest = m[3]; }
  return { k, rest: rest.trim() };
}

function block(L, i, ind) {
  if (i >= L.length || L[i].ind < ind) return { v: null, i };
  ind = L[i].ind;
  if (L[i].text === '-' || L[i].text.startsWith('- ')) {
    const a = [];
    while (i < L.length && L[i].ind === ind && (L[i].text === '-' || L[i].text.startsWith('- '))) {
      const item = L[i].text.slice(1).trim();
      if (item === '') { const r = block(L, i + 1, ind + 1); a.push(r.v); i = r.i; continue; }
      const kv = (item[0] !== '{' && item[0] !== '[' && item[0] !== '"' && item[0] !== "'") ? keyVal(item) : null;
      if (kv) {
        // "- key: v" followed by more keys at ind+2
        const sub = [{ ind: ind + 2, text: item }];
        let j = i + 1;
        while (j < L.length && L[j].ind > ind) { sub.push(L[j]); j++; }
        a.push(block(sub, 0, ind + 2).v); i = j; continue;
      }
      a.push(scalar(item)); i++;
    }
    return { v: a, i };
  }
  const o = {};
  while (i < L.length && L[i].ind === ind) {
    const kv = keyVal(L[i].text);
    if (!kv) throw new Error('cannot read line: ' + L[i].text);
    if (kv.rest === '' ) { const r = block(L, i + 1, ind + 1); o[kv.k] = r.v; i = r.i; continue; }
    if (/^[>|][-+]?$/.test(kv.rest)) {
      const parts = []; let j = i + 1;
      while (j < L.length && L[j].ind > ind) { parts.push(L[j].text); j++; }
      o[kv.k] = kv.rest[0] === '>' ? parts.join(' ') : parts.join('\n');
      i = j; continue;
    }
    o[kv.k] = scalar(kv.rest); i++;
  }
  return { v: o, i };
}

function section(text, name) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (new RegExp('^' + name + ':\\s*(#.*)?$').test(lines[i])) { start = i; break; }
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) { if (/^\S/.test(lines[i]) && !/^#/.test(lines[i])) break; out.push(lines[i]); }
  return out.join('\n');
}

/* -> { customize: {entity_id: attrs}, scripts: {object_id: {alias, icon}} } */
function readMoodFile(text) {
  const ha = section(text, 'homeassistant');
  const customize = ha ? (block(lex(ha), 0, 0).v || {}).customize || {} : {};
  const scripts = {};
  const sc = section(text, 'script');
  if (sc) {
    let cur = null;
    sc.split(/\r?\n/).forEach((l) => {
      let m = /^ {2}([a-z0-9_]+):\s*$/.exec(l);
      if (m) { cur = scripts[m[1]] = {}; return; }
      m = /^ {4}(alias|icon):\s*(.+)$/.exec(stripComment(l));
      if (m && cur) cur[m[1]] = scalar(m[2]);
    });
  }
  return { customize, scripts };
}

/* the input_select helpers a package file defines (moods_settings.yaml): {object_id: {name, icon, options}} */
function readHelpers(text) {
  const sec = section(text, 'input_select');
  return sec ? (block(lex(sec), 0, 0).v || {}) : {};
}
function loadHelpers(dir) {
  const out = {};
  fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().forEach((f) => {
    const h = readHelpers(fs.readFileSync(path.join(dir, f), 'utf8'));
    Object.keys(h).forEach((k) => { out['input_select.' + k] = Object.assign({ file: f }, h[k]); });
  });
  return out;
}

/* every mood in a package folder, as HouseSim wants them */
function loadMoods(dir) {
  const moods = [];
  fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().forEach((f) => {
    const r = readMoodFile(fs.readFileSync(path.join(dir, f), 'utf8'));
    Object.keys(r.customize).forEach((id) => {
      const a = r.customize[id];
      if (!a || a.mood !== true || !/^script\./.test(id)) return;
      const s = r.scripts[id.replace(/^script\./, '')] || {};
      moods.push({ entity_id: id, attributes: a, alias: s.alias, icon: s.icon, file: f });
    });
  });
  return moods;
}

module.exports = { readMoodFile, loadMoods, readHelpers, loadHelpers, scalar };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--check') {
    // compare with PyYAML for every file's homeassistant section
    const dir = args[1] || path.join(__dirname, '..', '..', 'ha', 'packages', 'moods');   // default: the package
    const { execFileSync } = require('child_process');
    const py = 'import sys,json,yaml\nclass L(yaml.SafeLoader): pass\nL.add_constructor("!include_dir_named", lambda l,n: None)\nout={}\nfor f in sys.argv[1:]:\n  d=yaml.load(open(f), Loader=L) or {}\n  out[f]={"customize":(d.get("homeassistant") or {}).get("customize") or {},"input_select":d.get("input_select") or {}}\nprint(json.dumps(out, sort_keys=True))\n';
    const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(dir, f));
    const theirs = JSON.parse(execFileSync('uv', ['run', '-q', '--with', 'pyyaml', 'python', '-I', '-c', py].concat(files), { encoding: 'utf8' }));
    let bad = 0;
    const norm = (o) => JSON.stringify(o, Object.keys(JSON.parse(JSON.stringify(o)) || {}).sort ? (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).sort().reduce((r, kk) => { r[kk] = v[kk]; return r; }, {}) : v) : undefined);
    files.forEach((f) => {
      const text = fs.readFileSync(f, 'utf8');
      const mine = readMoodFile(text).customize, helpers = readHelpers(text);
      const a = norm(mine) + norm(helpers), b = norm(theirs[f].customize) + norm(theirs[f].input_select);
      if (a !== b) { bad++; console.log('DIFFERS ' + f + '\n mine:   ' + a + '\n pyyaml: ' + b); } else console.log('same    ' + path.basename(f) + ' (' + Object.keys(mine).length + ' customize entries, ' + Object.keys(helpers).length + ' input_select)');
    });
    process.exit(bad ? 1 : 0);
  }
  args.forEach((f) => console.log(JSON.stringify(readMoodFile(fs.readFileSync(f, 'utf8')), null, 2)));
}
