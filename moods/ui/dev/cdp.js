#!/usr/bin/env node
/* Drive headless Chrome over the DevTools protocol, with real time (no virtual-time budget, so
   setTimeout-driven sequences run as they do on the phone). No npm dependencies: Node 24's
   built-in WebSocket client talks to Chrome.

   As a library:  const cdp = require('./cdp'); const b = await cdp.launch(); const p = await b.page(360, 640);
                  await p.go(url); await p.shot(file); await p.eval('1+1'); await b.close();
   As a tool:     node ui/dev/cdp.js shot <url> <out.png> [w h wait_ms]

   The viewport is exact (Emulation.setDeviceMetricsOverride, DPR 2), so innerWidth/innerHeight are
   what the page sees on the phone (360x640 or 424x753 CSS px). */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

async function launch(opts = {}) {
  const port = opts.port || 9300 + Math.floor(Math.random() * 500);
  const dir = fs.mkdtempSync(path.join(opts.tmp || os.tmpdir(), 'pm-cdp-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--hide-scrollbars', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + port, '--user-data-dir=' + dir, '--window-size=900,1200',
    '--autoplay-policy=no-user-gesture-required', 'about:blank'
  ], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 100 && !ver; i++) { await sleep(100); try { ver = await getJSON(`http://127.0.0.1:${port}/json/version`); } catch (e) {} }
  if (!ver) { proc.kill(); throw new Error('chrome did not start'); }
  const browser = {
    port, proc, dir,
    async page(w = 360, h = 640) {
      const list = await getJSON(`http://127.0.0.1:${port}/json/list`);
      const t = list.find((x) => x.type === 'page');
      const p = await connect(t.webSocketDebuggerUrl);
      await p.send('Page.enable');
      await p.send('Runtime.enable');
      await p.size(w, h);
      return p;
    },
    async close() { try { proc.kill(); } catch (e) {} await sleep(200); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  };
  return browser;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waits = {};
    const listeners = [];
    const consoleLines = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && waits[m.id]) { const w = waits[m.id]; delete waits[m.id]; m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); return; }
      if (m.method === 'Runtime.consoleAPICalled') consoleLines.push(m.params.type + ': ' + m.params.args.map((a) => a.value !== undefined ? a.value : a.description).join(' '));
      if (m.method === 'Runtime.exceptionThrown') consoleLines.push('EXCEPTION: ' + (m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text));
      listeners.forEach((l) => l(m));
    };
    ws.onerror = (e) => reject(e);
    ws.onopen = () => {
      const p = {
        console: consoleLines,
        send(method, params = {}) { return new Promise((res, rej) => { const i = ++id; waits[i] = { res, rej }; ws.send(JSON.stringify({ id: i, method, params })); }); },
        on(fn) { listeners.push(fn); },
        async size(w, h) { p.w = w; p.h = h; await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true }); await p.send('Emulation.setTouchEmulationEnabled', { enabled: false }); },
        async go(url, waitMs = 1500) {
          const loaded = new Promise((r) => { const f = (m) => { if (m.method === 'Page.loadEventFired') r(); }; listeners.push(f); });
          await p.send('Page.navigate', { url });
          await Promise.race([loaded, sleep(10000)]);
          await sleep(waitMs);
        },
        async inject(js) { await p.send('Page.addScriptToEvaluateOnNewDocument', { source: js }); },
        async eval(expr) {
          const r = await p.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
          if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
          return r.result.value;
        },
        async shot(file) {
          const r = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
          return file;
        },
        async mouse(type, x, y, extra = {}) { await p.send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse' }, extra)); },
        async tap(x, y) { await p.mouse('mouseMoved', x, y, { buttons: 0 }); await p.mouse('mousePressed', x, y); await sleep(40); await p.mouse('mouseReleased', x, y); },
        async press(x, y, ms) { await p.mouse('mouseMoved', x, y, { buttons: 0 }); await p.mouse('mousePressed', x, y); await sleep(ms); await p.mouse('mouseReleased', x, y); },
        async key(k) {
          const code = { ArrowRight: 39, ArrowLeft: 37, Escape: 27, Enter: 13 }[k] || 0;
          await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: code });
          await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code });
        },
        close() { ws.close(); }
      };
      resolve(p);
    };
  });
}

module.exports = { launch, sleep };

if (require.main === module) {
  (async () => {
    const [cmd, url, out, w, h, wait] = process.argv.slice(2);
    if (cmd !== 'shot' || !url || !out) { console.error('usage: cdp.js shot <url> <out.png> [w h wait_ms]'); process.exit(2); }
    const b = await launch();
    try {
      const p = await b.page(+w || 360, +h || 640);
      await p.go(url, +wait || 2500);
      await p.shot(out);
      if (p.console.length) console.log(p.console.join('\n'));
      console.log('wrote ' + out);
    } finally { await b.close(); }
  })().catch((e) => { console.error(e); process.exit(1); });
}
