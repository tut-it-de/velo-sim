import { FELDBERG_TAUNUS_LENGTH_M, FELDBERG_TAUNUS_PATH, FELDBERG_TAUNUS_SEGMENTS } from './data/feldbergTaunus';
import { LAGO_DI_COMO_LENGTH_M, LAGO_DI_COMO_PATH, LAGO_DI_COMO_SEGMENTS } from './data/lagoDiComo';
import { Track } from './track';
import type { RouteDefinition, RoutePath } from './types';

/** Generated paths store delta-encoded decimetres (see tools/geo). */
function decodePath(p: { step: number; x: number[]; z: number[]; y: number[] }): RoutePath {
  const decode = (d: number[]) => {
    const out = new Float64Array(d.length);
    let acc = 0;
    for (let i = 0; i < d.length; i++) out[i] = (acc += d[i]!) / 10;
    return out;
  };
  return { step: p.step, x: decode(p.x), z: decode(p.z), y: decode(p.y) };
}

/**
 * Polar loop r(θ) = 1 + Σ a·sin(kθ + φ). Any curve with r > 0 is a simple
 * closed curve, so these shapes can never self-intersect.
 */
function polarLoop(points: number, harmonics: Array<[k: number, amp: number, phase: number]>, sx = 1, sz = 1): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < points; i++) {
    const t = (i / points) * Math.PI * 2;
    const r = 1 + harmonics.reduce((acc, [k, a, p]) => acc + a * Math.sin(k * t + p), 0);
    out.push([sx * r * Math.cos(t), sz * r * Math.sin(t)]);
  }
  return out;
}

export const KUESTENRUNDE: RouteDefinition = {
  id: 'kuestenrunde',
  name: 'Küstenrunde',
  description: 'Flach am Meer entlang mit langen Geraden – hier zählt Aerodynamik.',
  style: 'coast',
  lengthM: 16000,
  shape: polarLoop(
    48,
    [
      [3, 0.08, 0.3],
      [5, 0.05, 1.1],
      [7, 0.03, 2.0],
    ],
    1.8,
    1,
  ),
  elevation: [
    [0, 6],
    [1200, 6],
    [2000, 19],
    [2700, 20],
    [3400, 9],
    [5200, 5],
    [6200, 13],
    [7000, 15],
    [8300, 7],
    [9800, 4],
    [10800, 5],
    [11600, 17],
    [12200, 22],
    [13000, 12],
    [14400, 6],
  ],
  segments: [
    { id: 'leuchtturm', name: 'Leuchtturm-Rampe', type: 'climb', startM: 1200, endM: 2000 },
    { id: 'hafen-sprint', name: 'Hafen-Sprint', type: 'sprint', startM: 14600, endM: 15100 },
  ],
};

export const HUEGELRUNDE: RouteDefinition = {
  id: 'huegelrunde',
  name: 'Hügelrunde',
  description: 'Wellig durchs Hügelland: fünf kurze Anstiege zwischen 4 und 8 %.',
  style: 'hills',
  lengthM: 13000,
  shape: polarLoop(
    48,
    [
      [2, 0.15, 0.5],
      [3, 0.1, 2.0],
      [5, 0.06, 0.7],
      [8, 0.02, 1.4],
    ],
    1.3,
    1,
  ),
  elevation: [
    [0, 100],
    [900, 102],
    [1800, 160],
    [2000, 162],
    [2900, 118],
    [3500, 115],
    [4100, 160],
    [5000, 155],
    [6200, 105],
    [6800, 102],
    [7300, 138],
    [8500, 118],
    [9200, 120],
    [9900, 146],
    [10300, 176],
    [10600, 180],
    [12300, 102],
  ],
  segments: [
    { id: 'kapellenberg', name: 'Kapellenberg', type: 'climb', startM: 900, endM: 1800 },
    { id: 'weinberg', name: 'Weinberg', type: 'climb', startM: 3500, endM: 4100 },
    { id: 'muehlenrampe', name: 'Mühlenrampe', type: 'climb', startM: 6800, endM: 7300 },
    { id: 'panoramaweg', name: 'Panoramaweg', type: 'climb', startM: 9200, endM: 10600 },
    { id: 'dorfsprint', name: 'Dorfsprint', type: 'sprint', startM: 12400, endM: 12900 },
  ],
};

export const BERGRUNDE: RouteDefinition = {
  id: 'bergrunde',
  name: 'Bergrunde',
  description: 'Alpiner Pass mit 5 km Anstieg (Ø 7 %, Rampe bis 12 %), schnelle Abfahrt – hier zählt Gewicht.',
  style: 'alpine',
  lengthM: 18000,
  shape: polarLoop(
    56,
    [
      [2, 0.2, 1.3],
      [4, 0.08, 0.2],
      [6, 0.05, 1.7],
      [9, 0.035, 0.4],
      [12, 0.012, 2.2],
    ],
    1,
    1.5,
  ),
  elevation: [
    [0, 200],
    [700, 215],
    [1300, 205],
    [2000, 210],
    [3000, 275],
    [3600, 325],
    [4000, 352],
    [4300, 388],
    [5000, 430],
    [6000, 505],
    [6600, 548],
    [7000, 580],
    [8000, 585],
    [9000, 505],
    [9800, 430],
    [11000, 335],
    [12500, 250],
    [13500, 250],
    [14500, 330],
    [15000, 325],
  ],
  segments: [
    { id: 'passo-alto', name: 'Passo Alto', type: 'climb', startM: 2000, endM: 7000 },
    { id: 'talabfahrt', name: 'Talabfahrt', type: 'descent', startM: 8000, endM: 12500 },
    { id: 'kehrenwand', name: 'Kehrenwand', type: 'climb', startM: 13500, endM: 14500 },
    { id: 'seesprint', name: 'Seesprint', type: 'sprint', startM: 16800, endM: 17300 },
  ],
};

export const LAGO_DI_COMO: RouteDefinition = {
  id: 'lago-di-como',
  name: 'Lago di Como – Bellagio Loop',
  description:
    'Echte Straßen am Comer See: Start an der Piazza Mazzini in Bellagio, Uferstraße nach Limonta und der Anstieg über Guello nach Civenna.',
  region: 'Comer See · Italien',
  style: 'lake',
  lengthM: LAGO_DI_COMO_LENGTH_M,
  path: decodePath(LAGO_DI_COMO_PATH),
  world: 'lago-di-como',
  segments: LAGO_DI_COMO_SEGMENTS,
};

export const FELDBERG_TAUNUS: RouteDefinition = {
  id: 'feldberg-taunus',
  name: 'Großer Feldberg – ab Hohemark',
  description:
    'Der Taunus-Klassiker auf echten Straßen: vom Waldtraut an der Hohemark die Kanonenstraße durch den Wald hinauf zum Sandplacken, über die Hochtaunusstraße zum Gipfel (879 m), Wende auf dem Gipfelplateau und Abfahrt bis zum Kreisel an der Hohemark.',
  region: 'Taunus · Deutschland',
  style: 'hills',
  lengthM: FELDBERG_TAUNUS_LENGTH_M,
  path: decodePath(FELDBERG_TAUNUS_PATH),
  world: 'feldberg-taunus',
  segments: FELDBERG_TAUNUS_SEGMENTS,
};

export const ROUTES: RouteDefinition[] = [LAGO_DI_COMO, FELDBERG_TAUNUS, KUESTENRUNDE, HUEGELRUNDE, BERGRUNDE];

const trackCache = new Map<string, Track>();

/** Builds (once) and returns the sampled track for a route id. */
export function getTrack(id: string): Track {
  let track = trackCache.get(id);
  if (!track) {
    const def = ROUTES.find((r) => r.id === id);
    if (!def) throw new Error(`Unbekannte Strecke: ${id}`);
    track = new Track(def);
    trackCache.set(id, track);
  }
  return track;
}
