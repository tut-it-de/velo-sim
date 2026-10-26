import { heartRateZone, HEART_RATE_ZONES, powerZone, type ActivitySample } from '@velo/metrics';

/**
 * The ride report (like Zwift's "Fahrt-Bericht"), drawn on a canvas: the headline numbers, the ride over
 * time (power bars in zone colours, heart rate and cadence as lines) and how the power and the heart rate
 * were distributed. The same drawing is shown at the end of the ride and saved as a picture to share.
 */
export interface ReportData {
  title: string;
  subtitle: string;
  durationS: number;
  distanceM: number;
  avgPower: number;
  normalizedPower: number;
  calories: number;
  ascentM: number;
  /** 1 Hz samples of the ride. */
  samples: ActivitySample[];
  /** 0 = unknown: the power bars stay in one colour. */
  ftp: number;
  maxHr: number;
  /** The maximum heart rate is assumed (not set by the rider). */
  maxHrAssumed: boolean;
}

export interface ReportSeries {
  power: boolean;
  cadence: boolean;
  heartRate: boolean;
}

export const REPORT_WIDTH = 1200;
export const REPORT_HEIGHT = 800;

const C = {
  page: '#14171c',
  panel: '#22262d',
  grid: 'rgba(255,255,255,0.07)',
  text: '#f2f4f7',
  muted: '#9aa3ad',
  accent: '#74c0fc',
  hr: '#e5484d',
  cadence: '#f5c542',
  plainBar: '#5b8def',
};
const FONT = '"Barlow Condensed", "Barlow", system-ui, sans-serif';

function font(px: number, weight = 600, italic = false): string {
  return `${italic ? 'italic ' : ''}${weight} ${px}px ${FONT}`;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function clock(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return h ? `${h}:${mm}:${String(sec).padStart(2, '0')}` : `${mm}:${String(sec).padStart(2, '0')}`;
}

/** Mean of each of `n` equal slices of `values` (undefined where a slice has no value). */
function buckets(values: Array<number | undefined>, n: number): Array<number | undefined> {
  const out: Array<number | undefined> = [];
  for (let b = 0; b < n; b++) {
    const from = Math.floor((b * values.length) / n);
    const to = Math.max(from + 1, Math.floor(((b + 1) * values.length) / n));
    let sum = 0;
    let k = 0;
    for (let i = from; i < to && i < values.length; i++) {
      const v = values[i];
      if (v !== undefined && v > 0) {
        sum += v;
        k++;
      }
    }
    out.push(k ? sum / k : undefined);
  }
  return out;
}

export function drawRideReport(canvas: HTMLCanvasElement, d: ReportData, series: ReportSeries, scale = 1): void {
  canvas.width = REPORT_WIDTH * scale;
  canvas.height = REPORT_HEIGHT * scale;
  const g = canvas.getContext('2d')!;
  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.fillStyle = C.page;
  g.fillRect(0, 0, REPORT_WIDTH, REPORT_HEIGHT);

  // header band
  g.fillStyle = C.accent;
  g.fillRect(0, 0, REPORT_WIDTH, 64);
  g.fillStyle = '#04121f';
  g.font = font(40, 700, true);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('FAHRT-BERICHT', REPORT_WIDTH / 2, 34);

  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = C.text;
  g.font = font(28, 700);
  g.fillText(d.title, 32, 108, 760);
  g.fillStyle = C.muted;
  g.font = font(20, 500);
  g.textAlign = 'right';
  g.fillText(d.subtitle, REPORT_WIDTH - 32, 108, 380);

  // headline numbers
  const stats: Array<[string, string, string]> = [
    ['⚡', String(Math.round(d.avgPower)), 'W Ø'],
    ['NP', String(Math.round(d.normalizedPower)), 'W'],
    ['↗', (d.distanceM / 1000).toFixed(1).replace('.', ','), 'km'],
    ['◷', clock(d.durationS), ''],
    ['▲', String(Math.round(d.ascentM)), 'hm'],
    ['🔥', String(Math.round(d.calories)), 'kcal'],
  ];
  const statW = (REPORT_WIDTH - 64) / stats.length;
  stats.forEach(([icon, value, unit], i) => {
    const x = 32 + i * statW;
    g.textAlign = 'left';
    g.fillStyle = C.accent;
    g.font = font(22, 700);
    g.fillText(icon, x, 168);
    const iw = g.measureText(icon).width + 8;
    g.fillStyle = C.text;
    g.font = font(48, 700, true);
    g.fillText(value, x + iw, 172);
    const vw = g.measureText(value).width + 6;
    g.fillStyle = C.muted;
    g.font = font(20, 600);
    g.fillText(unit, x + iw + vw, 172);
  });

  drawTimeline(g, d, series, 32, 200, REPORT_WIDTH - 64, 300);
  drawLegend(g, series, 32, 532);
  const half = (REPORT_WIDTH - 64 - 24) / 2;
  drawPowerDistribution(g, d, 32, 556, half, 212);
  drawHeartRateDistribution(g, d, 32 + half + 24, 556, half, 212);

  g.fillStyle = C.muted;
  g.font = font(16, 500);
  g.textAlign = 'right';
  g.fillText('WFR – Was für Rolle!!', REPORT_WIDTH - 32, REPORT_HEIGHT - 10);
}

function panel(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, title?: string): void {
  g.fillStyle = C.panel;
  roundRect(g, x, y, w, h, 10);
  g.fill();
  if (!title) return;
  g.fillStyle = C.text;
  g.font = font(22, 700);
  g.textAlign = 'center';
  g.fillText(title, x + w / 2, y + 28);
}

function drawTimeline(g: CanvasRenderingContext2D, d: ReportData, series: ReportSeries, x: number, y: number, w: number, h: number): void {
  panel(g, x, y, w, h);
  const s = d.samples;
  const px = { x: x + 12, y: y + 30, w: w - 24, h: h - 58 };
  if (s.length < 2) {
    g.fillStyle = C.muted;
    g.font = font(22, 500);
    g.textAlign = 'center';
    g.fillText('Zu wenige Messwerte', x + w / 2, y + h / 2);
    return;
  }
  const n = Math.min(s.length, Math.floor(px.w / 3));
  const barW = px.w / n;
  const power = buckets(
    s.map((v) => v.power),
    n,
  );
  const hr = buckets(
    s.map((v) => v.heartRate),
    n,
  );
  const cad = buckets(
    s.map((v) => v.cadence),
    n,
  );
  const maxP = Math.max(...s.map((v) => v.power), 100);
  const pTop = maxP * 1.12;

  g.strokeStyle = C.grid;
  g.lineWidth = 1;
  for (let k = 1; k < 4; k++) {
    const gy = px.y + (px.h * k) / 4;
    g.beginPath();
    g.moveTo(px.x, gy);
    g.lineTo(px.x + px.w, gy);
    g.stroke();
  }

  if (series.power) {
    power.forEach((p, i) => {
      if (!p) return;
      const bh = (p / pTop) * px.h;
      g.fillStyle = d.ftp > 0 ? powerZone(p, d.ftp).color : C.plainBar;
      g.fillRect(px.x + i * barW, px.y + px.h - bh, Math.max(1, barW - 0.6), bh);
    });
  }

  const line = (values: Array<number | undefined>, top: number, color: string, width: number) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.lineJoin = 'round';
    g.beginPath();
    let pen = false;
    values.forEach((v, i) => {
      if (v === undefined) {
        pen = false;
        return;
      }
      const lx = px.x + (i + 0.5) * barW;
      const ly = px.y + px.h - (v / top) * px.h;
      if (pen) g.lineTo(lx, ly);
      else g.moveTo(lx, ly);
      pen = true;
    });
    g.stroke();
  };
  const hrValues = s.map((v) => v.heartRate ?? 0);
  const maxHrSeen = Math.max(...hrValues);
  if (series.cadence) line(cad, 160, C.cadence, 1.5);
  if (series.heartRate && maxHrSeen > 0) line(hr, Math.max(200, maxHrSeen * 1.1), C.hr, 2.5);

  // markers like Zwift: the highest power and heart rate of the ride; a second label close to the first
  // one moves aside
  let first: number | undefined;
  const mark = (index: number, value: number, top: number, label: string, color: string) => {
    const mx = px.x + ((index + 0.5) / s.length) * px.w;
    const my = px.y + px.h - (value / top) * px.h;
    const shift = first !== undefined && Math.abs(first - mx) < 90 ? (mx >= first ? 90 : -90) : 0;
    first ??= mx;
    g.strokeStyle = color;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(mx, my);
    g.lineTo(mx, my - 14);
    g.stroke();
    g.fillStyle = C.text;
    g.font = font(17, 700);
    g.textAlign = 'center';
    g.fillText(label, Math.min(px.x + px.w - 40, Math.max(px.x + 40, mx + shift)), Math.max(px.y - 4, my - 18));
  };
  if (series.power) {
    const i = s.reduce((best, v, k) => (v.power > s[best]!.power ? k : best), 0);
    mark(i, s[i]!.power, pTop, `${Math.round(s[i]!.power)} W`, '#fff');
  }
  if (series.heartRate && maxHrSeen > 0) {
    const i = hrValues.indexOf(maxHrSeen);
    mark(i, maxHrSeen, Math.max(200, maxHrSeen * 1.1), `${maxHrSeen} bpm`, C.hr);
  }

  // time axis
  g.fillStyle = C.muted;
  g.font = font(15, 500);
  const total = s.length;
  const step = [60, 300, 600, 900, 1800, 3600].find((t) => total / t <= 8) ?? 7200;
  for (let t = 0; t <= total; t += step) {
    const tx = px.x + (t / total) * px.w;
    g.textAlign = t === 0 ? 'left' : 'center';
    g.fillText(clock(t), tx, y + h - 8);
  }
}

function drawLegend(g: CanvasRenderingContext2D, series: ReportSeries, x: number, y: number): void {
  const items: Array<[boolean, string, string]> = [
    [series.power, 'Leistung', C.plainBar],
    [series.cadence, 'Trittfrequenz', C.cadence],
    [series.heartRate, 'Herzfrequenz', C.hr],
  ];
  let cx = x;
  g.font = font(18, 600);
  g.textAlign = 'left';
  for (const [on, label, color] of items) {
    g.beginPath();
    g.arc(cx + 7, y - 6, 6, 0, Math.PI * 2);
    g.fillStyle = on ? color : 'transparent';
    g.fill();
    g.strokeStyle = on ? color : C.muted;
    g.lineWidth = 1.5;
    g.stroke();
    g.fillStyle = on ? C.text : C.muted;
    g.fillText(label, cx + 20, y);
    cx += 40 + g.measureText(label).width;
  }
}

/** Bars of a histogram, an "Ø" flag at the average and value labels on the axis. */
function histogram(
  g: CanvasRenderingContext2D,
  area: { x: number; y: number; w: number; h: number },
  bins: number[],
  from: number,
  width: number,
  color: (center: number) => string,
  average: number,
  labelEvery: number,
): void {
  const top = Math.max(...bins, 1);
  const bw = area.w / bins.length;
  bins.forEach((v, i) => {
    if (!v) return;
    const bh = Math.max(2, (v / top) * area.h);
    g.fillStyle = color(from + (i + 0.5) * width);
    g.fillRect(area.x + i * bw + 1, area.y + area.h - bh, bw - 2, bh);
  });
  g.fillStyle = C.muted;
  g.font = font(14, 500);
  g.textAlign = 'center';
  for (let i = 0; i <= bins.length; i += labelEvery) g.fillText(String(from + i * width), area.x + i * bw, area.y + area.h + 18);
  if (average > 0) {
    const ax = area.x + ((average - from) / (bins.length * width)) * area.w;
    if (ax < area.x || ax > area.x + area.w) return;
    const label = `Ø ${Math.round(average)}`;
    g.font = font(16, 700);
    const lw = g.measureText(label).width + 12;
    g.fillStyle = '#5d6570';
    roundRect(g, ax - lw / 2, area.y - 4, lw, 22, 5);
    g.fill();
    g.fillStyle = '#fff';
    g.fillText(label, ax, area.y + 12);
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(ax, area.y + 18);
    g.lineTo(ax, area.y + area.h);
    g.stroke();
  }
}

function drawPowerDistribution(g: CanvasRenderingContext2D, d: ReportData, x: number, y: number, w: number, h: number): void {
  panel(g, x, y, w, h, 'Leistungsverteilung');
  const power = d.samples.map((s) => s.power).filter((p) => p > 0);
  const width = 25;
  const maxP = Math.max(...power, 100);
  const count = Math.min(24, Math.ceil((maxP + 1) / width));
  const bins = new Array<number>(count).fill(0);
  for (const p of power) bins[Math.min(count - 1, Math.floor(p / width))]! += 1;
  const area = { x: x + 18, y: y + 46, w: w - 36, h: h - 96 };
  histogram(g, area, bins, 0, width, (c) => (d.ftp > 0 ? powerZone(c, d.ftp).color : C.plainBar), d.avgPower, count > 12 ? 4 : 2);
  g.fillStyle = C.muted;
  g.font = font(15, 600);
  g.textAlign = 'center';
  g.fillText(d.ftp > 0 ? `Watt · Zonen bei FTP ${d.ftp} W` : 'Watt', x + w / 2, y + h - 6);
}

function drawHeartRateDistribution(g: CanvasRenderingContext2D, d: ReportData, x: number, y: number, w: number, h: number): void {
  panel(g, x, y, w, h, 'Herzfrequenz-Verteilung');
  const hr = d.samples.map((s) => s.heartRate ?? 0).filter((v) => v > 0);
  const area = { x: x + 18, y: y + 46, w: w - 36, h: h - 96 };
  if (!hr.length) {
    g.fillStyle = C.muted;
    g.font = font(20, 500);
    g.textAlign = 'center';
    g.fillText('Kein Herzfrequenz-Gurt verbunden', x + w / 2, y + h / 2 + 10);
    return;
  }
  const from = 60;
  const width = 5;
  const count = Math.ceil((Math.max(d.maxHr, ...hr) + 1 - from) / width);
  // zone bands behind the bars, as in Zwift
  let lower = from;
  for (const z of HEART_RATE_ZONES) {
    const upper = Math.min(from + count * width, z.max === Infinity ? from + count * width : z.max * d.maxHr);
    if (upper <= lower) continue;
    const bx = area.x + ((lower - from) / (count * width)) * area.w;
    const ex = area.x + ((upper - from) / (count * width)) * area.w;
    g.globalAlpha = 0.28;
    g.fillStyle = z.color;
    g.fillRect(bx, area.y, ex - bx, area.h);
    g.globalAlpha = 1;
    g.fillStyle = C.text;
    g.font = font(13, 700);
    g.textAlign = 'center';
    if (ex - bx > 22) g.fillText(`Z${z.zone}`, (bx + ex) / 2, area.y + 14);
    lower = upper;
  }
  const bins = new Array<number>(count).fill(0);
  for (const v of hr) bins[Math.max(0, Math.min(count - 1, Math.floor((v - from) / width)))]! += 1;
  const avg = hr.reduce((a, b) => a + b, 0) / hr.length;
  histogram(g, area, bins, from, width, (c) => heartRateZone(c, d.maxHr).color, avg, 6);
  g.fillStyle = C.muted;
  g.font = font(15, 600);
  g.textAlign = 'center';
  g.fillText(`bpm · max. ${d.maxHr}${d.maxHrAssumed ? ' (angenommen)' : ''}`, x + w / 2, y + h - 6);
}

/** The report as a PNG file (2× for a sharp picture on phones). */
export async function reportPng(d: ReportData, series: ReportSeries): Promise<Uint8Array> {
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  drawRideReport(canvas, d, series, 2);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Das Bild konnte nicht erzeugt werden.');
  return new Uint8Array(await blob.arrayBuffer());
}
