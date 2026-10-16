// Renders one comparison shot of the ride view (see docs/REALISM_PLAN.md, section 1.3).
// Usage: node shot.mjs <out.png> <quality> <distanceM> [width=1672] [height=941] [route="Lago di Como"]
// Env: URL (default http://localhost:4173/), CHROME_PATH (own Chrome binary),
//      SOFTWARE=1 (SwiftShader instead of the GPU, for machines without one).
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const USAGE = 'usage: node shot.mjs <out.png> <quality> <distanceM> [width=1672] [height=941] [route="Lago di Como"]';
const [out, quality, distArg, W = '1672', H = '941', route = 'Lago di Como'] = process.argv.slice(2);
const distanceM = Number(distArg);
if (!out || !quality || !Number.isFinite(distanceM)) {
  console.error(USAGE);
  process.exit(2);
}

const args = process.env.SOFTWARE === '1'
  ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  : ['--ignore-gpu-blocklist', '--enable-gpu'];

const consoleErrors = [];
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    channel: process.env.CHROME_PATH ? undefined : 'chrome',
    args,
  });
  const page = await browser.newPage({ viewport: { width: Number(W), height: Number(H) } });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  // Same settings the app reads from localStorage; set before the app script runs.
  await page.addInitScript((q) => {
    localStorage.setItem(
      'velo.settings.v1',
      JSON.stringify({ rideOnline: false, graphicsQuality: q, riderName: 'Ali', country: 'DE' }),
    );
  }, quality);

  await page.goto(process.env.URL ?? 'http://localhost:4173/');
  await page.getByRole('button', { name: 'Simulator starten' }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: route }).click();
  await page.getByRole('button', { name: 'Los geht' }).click();
  await page.waitForSelector('.hud', { timeout: 600_000 });

  // window.__velo = { world, session } is set in apps/client/src/ui/RidePage.tsx.
  // session.state is private in TypeScript but reachable at runtime.
  await page.evaluate((d) => {
    if (!window.__velo) throw new Error('window.__velo fehlt');
    const { session } = window.__velo;
    session.state.distanceM = d;
    session.state.speedMps = 5.5;
    // Pacer bots: 48 m ahead, 35 m behind, 160 m behind (the rest further back).
    const offsets = [48, -35, -160];
    session.bots.forEach((b, i) => {
      const bd = d + (offsets[i] ?? -200 - 40 * i);
      b.state.distanceM = bd;
      b.renderDistance = bd;
      b.state.speedMps = 5.2;
    });
  }, distanceM);

  // Let the render loop catch up and the scene stream in around the new position.
  await page.waitForTimeout(4000);
  await mkdir(dirname(resolve(out)), { recursive: true });
  await page.screenshot({ path: out });
  console.log(out);
} finally {
  await browser?.close();
  if (consoleErrors.length) console.error('console errors:\n' + consoleErrors.join('\n'));
}
