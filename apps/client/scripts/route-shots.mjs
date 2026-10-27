#!/usr/bin/env node
// Captures real in-game screenshots of every route for the route cards (public/route-shots/<id>.jpg).
// Needs a production preview (npm run build && npx vite preview --port 4175 – the dev server renders the real-world routes broken) and Google Chrome; uses the `?ride=<id>&km=<km>` dev shortcut.
//   node scripts/route-shots.mjs                    # all routes from SHOTS
//   node scripts/route-shots.mjs lago-di-como=3.2   # one route at a given km
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.BASE ?? 'http://localhost:4175';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../public/route-shots');
const PORT = 9333;

/** Route id → km with a good view. */
const SHOTS = {
  'lago-di-como': 2.2,
  'feldberg-taunus': 9.5,
  'alpe-dhuez': 9,
  'taunus-mammolshain': 7.5,
  moenchbruch: 4,
  kuestenrunde: 1.6,
  huegelrunde: 9.8,
  bergrunde: 5.5,
  'regenbogen-boulevard': 1.6,
  'lava-festung': 3.6,
  'kuhweiden-ring': 1.4,
  'schneegipfel-pass': 3.2,
};

const args = process.argv.slice(2);
const jobs = args.length ? args.map((a) => a.split('=')).map(([id, km]) => [id, Number(km ?? SHOTS[id] ?? 1)]) : Object.entries(SHOTS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    ...(process.env.HEADFUL ? ['--window-position=40,40', '--no-first-run', '--no-default-browser-check'] : ['--headless=new']),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'velo-shots-'))}`,
    '--window-size=1600,900',
    '--hide-scrollbars',
    '--ignore-gpu-blocklist',
    '--use-angle=metal',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
let seq = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

try {
  let version;
  for (let i = 0; i < 50 && !version; i++) {
    await sleep(200);
    version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => undefined);
  }
  if (!version) throw new Error('Chrome startet nicht');
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (process.env.DEBUG && msg.method === 'Runtime.consoleAPICalled') console.log('  console:', msg.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
    if (process.env.DEBUG && msg.method === 'Runtime.exceptionThrown') console.log('  exception:', msg.params.exceptionDetails.exception?.description?.slice(0, 300));
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  await send('Runtime.enable', {}, sessionId);
  // a guest with an FTP: no login page, no FTP question in front of the world
  await send('Page.navigate', { url: BASE }, sessionId);
  await sleep(1500);
  await evaluate(`localStorage.setItem('velo.settings.v1', JSON.stringify({ guest: true, ftp: 230, weightKg: 75 }))`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  mkdirSync(OUT, { recursive: true });

  for (const [id, km] of jobs) {
    await send('Page.navigate', { url: `${BASE}/?ride=${id}&km=${km}` }, sessionId);
    // Wait for the world, then for streamed terrain/textures to settle.
    let ready = false;
    for (let i = 0; i < 240 && !ready; i++) {
      await sleep(500);
      ready = await evaluate(`!!window.__velo && !document.body.innerText.includes('kompiliert') && !document.body.innerText.includes('Lade')`).catch(() => false);
    }
    if (!ready) {
      console.warn(`✗ ${id}: Welt nicht geladen`);
      continue;
    }
    await sleep(9000);
    // Read the canvas right after a rendered frame (the drawing buffer is cleared once composited) – no HUD, no overlays.
    const dataUrl = await evaluate(`new Promise((resolve) => {
      const { scene, engine } = window.__velo.world;
      scene.onAfterRenderObservable.addOnce(() => resolve(engine.getRenderingCanvas().toDataURL('image/jpeg', 0.82)));
    })`);
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const file = join(OUT, `${id}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`✓ ${id} @ ${km} km → ${file}`);
  }
} finally {
  ws?.close();
  chrome.kill();
}
