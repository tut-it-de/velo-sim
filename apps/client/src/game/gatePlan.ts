import type { RouteSegment } from '@velo/routes';

/** Pure planning for the race arches: where they stand, what they say, how the banner text is laid out. */

export interface GateSpec {
  /** Distance along the lap in metres. */
  d: number;
  /** Small line above the title. */
  kicker: string;
  title: string;
  color: string;
}

export const START_COLOR = '#4dabf7';
export const SEGMENT_COLORS: Record<RouteSegment['type'], string> = { climb: '#c62828', sprint: '#2e7d32', descent: '#1565c0' };
const LABEL: Record<RouteSegment['type'], string> = { climb: 'BERGWERTUNG', sprint: 'SPRINT', descent: 'ABFAHRT' };
/** Arches closer than this become one arch. */
export const MERGE_DIST = 25;

interface Mark {
  d: number;
  role: 'finish' | 'start' | 'end';
  seg?: RouteSegment;
}

const PRIORITY = { finish: 0, start: 1, end: 2 } as const;

/** Start/finish arch plus one arch at each segment start and end; arches that would stand on top of each other are merged. */
export function planGates(lengthM: number, routeName: string, segments: RouteSegment[]): GateSpec[] {
  const wrap = (d: number) => ((d % lengthM) + lengthM) % lengthM;
  const marks: Mark[] = [{ d: 0, role: 'finish' }];
  for (const seg of segments) {
    marks.push({ d: wrap(seg.startM), role: 'start', seg });
    marks.push({ d: wrap(seg.endM), role: 'end', seg });
  }
  marks.sort((a, b) => a.d - b.d);
  // greedy clusters along the lap; the last one may wrap around onto the first
  const clusters: Mark[][] = [];
  for (const m of marks) {
    const last = clusters[clusters.length - 1];
    if (last && m.d - last[0]!.d < MERGE_DIST) last.push(m);
    else clusters.push([m]);
  }
  if (clusters.length > 1) {
    const first = clusters[0]!;
    const last = clusters[clusters.length - 1]!;
    if (first[0]!.d + lengthM - last[0]!.d < MERGE_DIST) {
      first.push(...last);
      clusters.pop();
    }
  }
  return clusters.map((c) => describe(c, routeName));
}

/** "SPRINT SODENER STRASSE" instead of "SPRINT SPRINT SODENER STRASSE". */
function named(seg: RouteSegment): string {
  const name = seg.name.toUpperCase();
  return name.split(/[\s-]+/).includes(LABEL[seg.type]) ? name : `${LABEL[seg.type]} ${name}`;
}

function describe(cluster: Mark[], routeName: string): GateSpec {
  const base = cluster.reduce((a, b) => (PRIORITY[b.role] < PRIORITY[a.role] ? b : a));
  const others = cluster.filter((m) => m !== base);
  const ends = others.filter((m) => m.role === 'end').map((m) => `ZIEL ${LABEL[m.seg!.type]}`);
  const starts = others.filter((m) => m.role === 'start').map((m) => named(m.seg!));
  if (base.role === 'finish') {
    const parts = [...ends, ...starts];
    return { d: base.d, kicker: parts.length ? parts.join(' · ') : routeName.toUpperCase(), title: 'START · ZIEL', color: START_COLOR };
  }
  const seg = base.seg!;
  const color = SEGMENT_COLORS[seg.type];
  if (base.role === 'start') return { d: base.d, kicker: [...ends, ...starts, LABEL[seg.type]].join(' · '), title: seg.name.toUpperCase(), color };
  return { d: base.d, kicker: [...ends, named(seg)].join(' · '), title: 'ZIEL', color };
}

/** Text width in px for `text` at font size `px`. */
export type Measure = (text: string, font: 'title' | 'kicker', px: number) => number;

export interface BannerLayout {
  /** One or two title lines. */
  lines: string[];
  kicker: string;
  /** Font sizes in metres on the banner. */
  titleM: number;
  kickerM: number;
  /** Banner height in metres. */
  heightM: number;
}

export const BANNER = {
  /** Clear of the tube corners above the panel ends. */
  pad: 0.5,
  single: { height: 1.6, title: 0.92, minTitle: 0.6 },
  double: { height: 2.3, title: 0.76, minTitle: 0.46 },
  kicker: 0.34,
  minKicker: 0.22,
};

/** Largest size ≤ max at which `text` fits into `avail` metres (width scales linearly with the font size). */
function fitSize(measure: Measure, text: string, font: 'title' | 'kicker', max: number, avail: number): number {
  const w = measure(text, font, 100) / 100;
  return w <= 0 ? max : Math.min(max, avail / w);
}

/** Cuts `text` down with an ellipsis until it fits at `size`. */
function ellipsize(measure: Measure, text: string, font: 'title' | 'kicker', size: number, avail: number): string {
  if (measure(text, font, size) <= avail) return text;
  let t = text;
  while (t.length > 1 && measure(`${t}…`, font, size) > avail) t = t.slice(0, -1).trimEnd();
  return `${t}…`;
}

/**
 * Fits kicker and title onto a banner `widthM` wide: shrink the title first, then break it into two lines
 * at the best word boundary, and only as a last resort shorten it with an ellipsis. Units are metres;
 * `measure` gets them as px (1 m = 1 px) so the layout is independent of the texture resolution.
 */
export function layoutBanner(measure: Measure, kicker: string, title: string, widthM: number): BannerLayout {
  const avail = Math.max(1, widthM - 2 * BANNER.pad);
  const k = fitSize(measure, kicker, 'kicker', BANNER.kicker, avail);
  const kickerM = Math.max(BANNER.minKicker, k);
  const kickerText = k < BANNER.minKicker ? ellipsize(measure, kicker, 'kicker', kickerM, avail) : kicker;

  const one = fitSize(measure, title, 'title', BANNER.single.title, avail);
  if (one >= BANNER.single.minTitle) return { lines: [title], kicker: kickerText, titleM: one, kickerM, heightM: BANNER.single.height };

  const words = title.split(' ');
  let best: { lines: string[]; size: number } | null = null;
  for (let i = 1; i < words.length; i++) {
    let a = words.slice(0, i).join(' ');
    let b = words.slice(i).join(' ');
    // never start or end a line with the separator dot
    if (a.endsWith(' ·')) a = a.slice(0, -2);
    if (b.startsWith('· ')) b = b.slice(2);
    if (!a || !b || a === '·' || b === '·') continue;
    const size = Math.min(fitSize(measure, a, 'title', BANNER.double.title, avail), fitSize(measure, b, 'title', BANNER.double.title, avail));
    if (!best || size > best.size) best = { lines: [a, b], size };
  }
  if (best && best.size >= BANNER.double.minTitle) {
    return { lines: best.lines, kicker: kickerText, titleM: best.size, kickerM, heightM: BANNER.double.height };
  }
  if (best && best.size > one * 1.15) {
    const size = BANNER.double.minTitle;
    return { lines: best.lines.map((l) => ellipsize(measure, l, 'title', size, avail)), kicker: kickerText, titleM: size, kickerM, heightM: BANNER.double.height };
  }
  const size = BANNER.single.minTitle;
  return { lines: [ellipsize(measure, title, 'title', size, avail)], kicker: kickerText, titleM: size, kickerM, heightM: BANNER.single.height };
}
