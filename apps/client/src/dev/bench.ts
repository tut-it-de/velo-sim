/**
 * Frame-time benchmark for devices without a dev console (iPad app). Only in builds with VITE_BENCH=1:
 * rides every route at each quality level with all bots packed around me, stands at fixed spots and logs
 * the mean frame time (and its CPU part) with everything on and with one part of the scene switched off at
 * a time, one `BENCH` line per spot (Capacitor forwards console.log to the
 * device console, `xcrun devicectl device process launch --console`). The ride reloads between runs; the
 * settings the app had before are restored at the end.
 */
import type { Scene } from '@babylonjs/core';

const STATE = 'velo.bench';
const SETTINGS = 'velo.settings.v1';
const QUALITIES = ['mittel'] as const;
const SPOTS: Record<string, number[]> = {
  'feldberg-taunus': [2000, 14000],
  'lago-di-como': [3000, 8500],
  'taunus-mammolshain': [6000, 10000],
  'alpe-dhuez': [9000, 16000],
};
const RUNS = QUALITIES.flatMap((q) => Object.keys(SPOTS).map((route) => ({ q, route })));
const WARMUP_MS = 12_000;
const SETTLE_MS = 4_000;
const MEASURE_MS = 4_000;

interface BenchState {
  run: number;
  settings: string | null;
  done?: boolean;
}

interface Bot {
  state: { speedMps: number; distanceM: number };
  renderDistance: number;
}

interface Velo {
  world: { scene: Scene; others: Map<string, unknown> };
  session: {
    teleport(m: number): void;
    state: { speedMps: number; distanceM: number };
    bots: Bot[];
    botsToDraw(drawn: ReadonlySet<string>): Set<string>;
  };
}

/** Mesh groups switched off one at a time, by name. */
const GROUPS: Array<[string, RegExp]> = [
  ['Gelände', /^(terrain-|far-ground)/],
  ['Straße', /^(road|verge|ring|side-roads|junction)/],
  ['Gebäude', /^(bld-|walls|wall-caps|landmark)/],
  ['Bäume', /^tree/],
  ['Kleinzeug', /^(roadside-flora|scatter-|guide-|street-lamps|rail-post|flower-box|lamp-|gate|lake-sail|lake-ferry|parking)/],
  ['Bot-Meshes', /^rider-/],
];

/**
 * Worst case for the riders: all 50 bots stand in a field from 50 m behind to 250 m ahead of me, so the
 * session draws its maximum of nearest avatars at every spot (instead of wherever the shared clock puts them).
 */
function packBots(session: Velo['session']): void {
  const s = session as unknown as { stepBots: () => void };
  s.stepBots = () => {
    session.bots.forEach((b, k) => {
      b.state = { speedMps: 0, distanceM: session.state.distanceM - 50 + (300 * (k + 0.5)) / session.bots.length };
    });
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Console line, and in the iPad app also a line in Documents/bench.txt (fetched with devicectl when the console drops). */
async function report(line: string): Promise<void> {
  console.log(line);
  const { Capacitor } = await import('@capacitor/core');
  if (!Capacitor.isNativePlatform()) return;
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
  await Filesystem.appendFile({ path: 'bench.txt', data: line + '\n', directory: Directory.Documents, encoding: Encoding.UTF8 }).catch(() =>
    Filesystem.writeFile({ path: 'bench.txt', data: line + '\n', directory: Directory.Documents, encoding: Encoding.UTF8 }),
  );
}

function load(): BenchState {
  try {
    const s = JSON.parse(sessionStorage.getItem(STATE) ?? 'null') as BenchState | null;
    if (s) return s;
  } catch {
    // first run
  }
  return { run: 0, settings: localStorage.getItem(SETTINGS) };
}

/**
 * Mean frame time over `ms` from requestAnimationFrame, and the CPU part of it: the time the scene spends
 * in JavaScript from before animations to after rendering (issuing the draw calls, not waiting for the GPU).
 */
async function measure(scene: Scene, ms: number): Promise<{ mean: number; cpu: number }> {
  let frames = 0;
  let total = 0;
  let cpu = 0;
  let t0 = 0;
  const before = scene.onBeforeAnimationsObservable.add(() => (t0 = performance.now()));
  const after = scene.onAfterRenderObservable.add(() => (cpu += performance.now() - t0));
  await new Promise<void>((done) => {
    let last = performance.now();
    const end = last + ms;
    const tick = (now: number) => {
      total += now - last;
      frames++;
      last = now;
      if (now < end) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
  scene.onBeforeAnimationsObservable.remove(before);
  scene.onAfterRenderObservable.remove(after);
  return { mean: total / frames, cpu: cpu / frames };
}

/** Called once before the app renders: sets up the next run or finishes. */
export function startBench(): void {
  const state = load();
  const run = RUNS[state.run];
  if (state.done) return;
  if (!run) {
    if (state.settings === null) localStorage.removeItem(SETTINGS);
    else localStorage.setItem(SETTINGS, state.settings);
    // stays in the session as done, so the reload below does not start the benchmark over
    sessionStorage.setItem(STATE, JSON.stringify({ ...state, done: true }));
    void report('BENCH done').then(() => {
      history.replaceState(null, '', location.pathname);
      location.reload();
    });
    return;
  }
  sessionStorage.setItem(STATE, JSON.stringify(state));
  const settings = { ...(JSON.parse(state.settings ?? '{}') as Record<string, unknown>) };
  // offline, as a guest when there is no account; the account itself is not touched
  settings.graphicsQuality = run.q;
  settings.rideOnline = false;
  settings.guest = true;
  const spots = SPOTS[run.route]!;
  const search = `?ride=${run.route}&km=${spots[0]! / 1000}&bots=1`;
  // the app reads the settings and the URL when its modules load: set both, then start over
  const next = JSON.stringify(settings);
  if (location.search !== search || localStorage.getItem(SETTINGS) !== next) {
    localStorage.setItem(SETTINGS, next);
    history.replaceState(null, '', search);
    location.reload();
    return;
  }
  void ride(state, run.q, run.route, spots);
}

async function ride(state: BenchState, quality: string, route: string, spots: number[]): Promise<void> {
  const w = window as unknown as { __velo?: Velo };
  while (!w.__velo) await sleep(500);
  const { world, session } = w.__velo;
  const scene = world.scene;
  packBots(session);
  await sleep(WARMUP_MS);
  const engine = scene.getEngine();
  const scaling = engine.getHardwareScalingLevel();
  const fmt = (r: { mean: number; cpu: number }) => `${r.mean.toFixed(1)}/${r.cpu.toFixed(1)}`;
  // one variant: switch something off, settle, measure, switch it back on
  const without = async (off: () => () => void, settle = 1000) => {
    const undo = off();
    await sleep(settle);
    const r = await measure(scene, MEASURE_MS);
    undo();
    await sleep(500);
    return r;
  };
  const hide = (re: RegExp) => () => {
    const meshes = scene.meshes.filter((m) => re.test(m.name) && m.isEnabled());
    for (const m of meshes) m.setEnabled(false);
    return () => meshes.forEach((m) => m.setEnabled(true));
  };
  for (const m of spots) {
    session.teleport(m);
    session.state.speedMps = 0;
    await sleep(SETTLE_MS);
    const parts: string[] = [];
    const base = await measure(scene, MEASURE_MS);
    parts.push(`alles ${fmt(base)}`);
    for (const [label, re] of GROUPS) parts.push(`ohne ${label} ${fmt(await without(hide(re)))}`);
    // bots gone entirely: no avatars, no posing or skinning in JavaScript
    parts.push(
      `ohne Bots ganz ${fmt(
        await without(() => {
          const pick = session.botsToDraw;
          session.botsToDraw = () => new Set();
          return () => (session.botsToDraw = pick);
        }, 2000),
      )}`,
    );
    parts.push(
      `ohne Spiegelung ${fmt(
        await without(() => {
          const targets = scene.customRenderTargets.splice(0);
          return () => scene.customRenderTargets.push(...targets);
        }),
      )}`,
    );
    parts.push(
      `ohne Schattenkarte ${fmt(
        await without(() => {
          const maps = scene.lights.map((l) => l.getShadowGenerator()?.getShadowMap()).filter((x) => !!x);
          for (const map of maps) map.refreshRate = 0;
          return () => maps.forEach((map) => (map.refreshRate = 1));
        }),
      )}`,
    );
    parts.push(
      `halbe Auflösung ${fmt(
        await without(() => {
          engine.setHardwareScalingLevel(scaling * 2);
          return () => engine.setHardwareScalingLevel(scaling);
        }),
      )}`,
    );
    const draws = scene.getActiveMeshes().length;
    await report(`BENCH ${quality} ${route} ${m} m (ms Bild/CPU): ${parts.join(', ')}, Draws ${draws}, Bots ${world.others.size}, Skalierung ${scaling.toFixed(2)}`);
  }
  sessionStorage.setItem(STATE, JSON.stringify({ ...state, run: state.run + 1 }));
  location.reload();
}
