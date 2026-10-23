// Test bench for the road geometry of the real-world routes: renders the fixed check points of
// checkpoints.json (tightest hairpins, junctions, the Feldberg summit) from fixed cameras, so the
// same spots can be compared before and after a change.
//
// Usage: node probe.mjs <outDir> [route-id …] [--only=<name>] [--views=top,low,chase] [--quality=hoch]
// Env:   URL (default http://localhost:8191/), CHROME_PATH, SOFTWARE=1 (see shot.mjs)
//
// Views (all centred on the check point, north is not fixed: the cameras follow the direction of travel)
//   top    straight down from 55 m: road edges, junction areas, folds
//   wide   straight down from 140 m: the whole junction or hairpin with its surroundings
//   low    oblique from 18 m up and 30 m back: walls, verges, height steps
//   chase  the normal ride camera 25 m before the check point
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--'));
if (!outDir) {
  console.error('usage: node probe.mjs <outDir> [route-id …] [--only=<name>] [--views=top,wide,low,chase] [--quality=hoch]');
  process.exit(2);
}
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const routes = args.filter((a) => !a.startsWith('--') && a !== outDir);
const only = opt('only', null);
const views = opt('views', 'top,wide,low,chase').split(',');
const quality = opt('quality', 'hoch');
const W = Number(opt('w', 1280));
const H = Number(opt('h', 800));
const base = process.env.URL ?? 'http://localhost:8191/';

const checkpoints = JSON.parse(await readFile(join(HERE, 'checkpoints.json'), 'utf8'));
const gl = process.env.SOFTWARE === '1'
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  : ['--ignore-gpu-blocklist', '--enable-gpu'];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  channel: process.env.CHROME_PATH ? undefined : 'chrome',
  args: gl,
});
let failed = false;
try {
  for (const [routeId, points] of Object.entries(checkpoints)) {
    if (routeId.startsWith('_')) continue;
    if (routes.length && !routes.includes(routeId)) continue;
    const list = points.filter((p) => !only || p.name.includes(only));
    if (!list.length) continue;
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript((q) => {
      localStorage.setItem('velo.settings.v1', JSON.stringify({ rideOnline: false, graphicsQuality: q, riderName: 'Ali', country: 'DE' }));
      // the app needs an account; a local one without token rides offline
      localStorage.setItem('velo.account.v1', JSON.stringify({ user: { id: 'probe', name: 'Ali', email: 'probe@example.test' } }));
    }, quality);
    await page.goto(`${base}?ride=${routeId}&km=${list[0].m / 1000}`);
    await page.waitForSelector('.hud', { timeout: 600_000 });
    await page.waitForFunction(() => !!window.__velo, null, { timeout: 60_000 });
    // the 3D view only: no HUD panels over the road
    await page.addStyleTag({ content: '.hud { visibility: hidden !important; }' });
    // free camera: replaces the ride camera; `window.__probeCam` = null gives the ride camera back
    await page.evaluate(() => {
      const w = window.__velo.world;
      const ride = w.updateCamera.bind(w);
      window.__probeCam = null;
      w.updateCamera = function (dt, me) {
        const c = window.__probeCam;
        if (!c) return ride(dt, me);
        this.camera.fov = c.fov ?? 0.9;
        this.camera.position.set(c.pos[0], c.pos[1], c.pos[2]);
        this.camera.setTarget(new this.camera.position.constructor(c.look[0], c.look[1], c.look[2]));
      };
    });
    for (const p of list) {
      for (const view of p.views ?? views) {
        if (!views.includes(view)) continue;
        await page.evaluate(
          ({ m, view, lat }) => {
            const { world, session } = window.__velo;
            const t = world.track;
            const at = view === 'chase' ? m - 25 : m;
            session.teleport(at);
            session.state.speedMps = 0;
            for (const b of session.bots ?? []) {
              b.state.distanceM = at + 400;
              b.renderDistance = at + 400;
            }
            const c = t.positionAt(m, lat ?? 0);
            const back = t.positionAt(m - 30, lat ?? 0);
            const fx = Math.sin(c.heading);
            const fz = Math.cos(c.heading);
            if (view === 'top') window.__probeCam = { pos: [c.x - fx * 0.01, c.y + 55, c.z - fz * 0.01], look: [c.x, c.y, c.z], fov: 0.9 };
            else if (view === 'wide') window.__probeCam = { pos: [c.x - fx * 0.01, c.y + 140, c.z - fz * 0.01], look: [c.x, c.y, c.z], fov: 0.9 };
            else if (view === 'low') window.__probeCam = { pos: [back.x, Math.max(back.y, c.y) + 18, back.z], look: [c.x, c.y, c.z], fov: 0.9 };
            else window.__probeCam = null;
          },
          { m: p.m, view, lat: p.lat },
        );
        await page.waitForTimeout(view === 'chase' ? 3500 : 2500);
        const file = resolve(outDir, `${routeId}--${p.name}--${view}.png`);
        await mkdir(dirname(file), { recursive: true });
        await page.screenshot({ path: file });
        console.log(file);
      }
    }
    if (errors.length) {
      failed = true;
      console.error(`${routeId}: console errors:\n` + errors.join('\n'));
    }
    await page.close();
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
