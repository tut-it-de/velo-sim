/**
 * Design reference (dev page, designsheet.html): every jersey from the front, back and both sides as
 * flat garments, every wheel from both sides, edge-on and in section. Drawn from the same textures the
 * 3D avatar uses (jerseyArt.ts, wheelArt.ts), so the sheet is the spec the model is checked against.
 */
import { JERSEYS, WHEELS, type JerseyItem, type WheelsItem } from '@velo/equipment';
import { BASE_SPEC } from '../game/avatar/geometry';
import { JERSEY_TEX, SLEEVE_H, TORSO_H, jerseyArtReady, paintJersey } from '../game/avatar/jerseyArt';
import { RIM_H, RIM_W, paintRim, rimGeometry } from '../game/avatar/wheelArt';

const q = new URLSearchParams(location.search);
const only = q.get('only'); // 'jerseys' | 'wheels'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function card(title: string, meta: string, id: string): HTMLDivElement {
  const c = el('div', 'card');
  c.id = id;
  c.append(el('h2', undefined, title), el('div', 'meta', meta));
  const views = el('div', 'views');
  c.append(views);
  sheet.append(c);
  return views;
}

function view(parent: HTMLElement, label: string, w: number, h: number): CanvasRenderingContext2D {
  const v = el('div', 'view');
  const c = el('canvas');
  c.width = w * 2;
  c.height = h * 2;
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  v.append(c, el('span', undefined, label));
  parent.append(v);
  const ctx = c.getContext('2d')!;
  ctx.scale(2, 2);
  return ctx;
}

// ------------------------------------------------------------------------------------- jerseys

const TW = 200; // torso width in px for half the circumference (0.43 m)
const TH = 260; // torso length (0.56 m)
const SW = 76; // sleeve: half its circumference
const SL = 72; // sleeve length

/** Draws the texture's u range [u0, u0 + 0.5] of the torso into the rectangle (wraps around u = 1). */
function torsoSlice(ctx: CanvasRenderingContext2D, tex: HTMLCanvasElement, u0: number, x: number, y: number, w: number, h: number): void {
  const a = ((u0 % 1) + 1) % 1;
  const first = Math.min(0.5, 1 - a);
  ctx.drawImage(tex, a * JERSEY_TEX, 0, first * JERSEY_TEX, TORSO_H, x, y, (first / 0.5) * w, h);
  if (first < 0.5) ctx.drawImage(tex, 0, 0, (0.5 - first) * JERSEY_TEX, TORSO_H, x + (first / 0.5) * w, y, ((0.5 - first) / 0.5) * w, h);
}

function sleeveSlice(ctx: CanvasRenderingContext2D, tex: HTMLCanvasElement, u0: number, w: number, h: number): void {
  // half the sleeve circumference, wrapping around the texture's right edge
  const sx = u0 * JERSEY_TEX;
  const first = Math.min(0.5 * JERSEY_TEX, JERSEY_TEX - sx);
  ctx.drawImage(tex, sx, TORSO_H, first, SLEEVE_H, 0, 0, (w * first) / (0.5 * JERSEY_TEX), h);
  if (first < 0.5 * JERSEY_TEX) {
    const rest = 0.5 * JERSEY_TEX - first;
    ctx.drawImage(tex, 0, TORSO_H, rest, SLEEVE_H, (w * first) / (0.5 * JERSEY_TEX), 0, (w * rest) / (0.5 * JERSEY_TEX), h);
  }
}

/** Flat jersey seen from the front or back: torso slice, two sleeves, neckline. */
function garment(ctx: CanvasRenderingContext2D, tex: HTMLCanvasElement, centreU: number, back: boolean): void {
  const W = 340;
  const x0 = (W - TW) / 2;
  const y0 = 34;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  // sleeves hanging from the shoulders, outward and down; local x = around the arm, y = shoulder → cuff
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(side < 0 ? x0 + 12 : x0 + TW - 12, y0 + 14);
    ctx.rotate(-side * 0.96);
    ctx.beginPath();
    ctx.roundRect(-SW / 2, -8, SW, SL + 8, 6);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.clip();
    ctx.translate(-SW / 2, -8);
    sleeveSlice(ctx, tex, (((centreU - 0.25) % 1) + 1) % 1, SW, SL + 8);
    ctx.restore();
  }
  // torso with a scooped neckline
  ctx.beginPath();
  const neck = back ? 10 : 26;
  ctx.moveTo(x0, y0 + 8);
  ctx.lineTo(x0 + TW * 0.34, y0);
  ctx.quadraticCurveTo(x0 + TW / 2, y0 + neck, x0 + TW * 0.66, y0);
  ctx.lineTo(x0 + TW, y0 + 8);
  ctx.lineTo(x0 + TW + 4, y0 + TH);
  ctx.quadraticCurveTo(x0 + TW / 2, y0 + TH + (back ? 18 : 6), x0 - 4, y0 + TH);
  ctx.closePath();
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.clip();
  torsoSlice(ctx, tex, centreU - 0.25, x0 - 4, y0 - 4, TW + 8, TH + 22);
  ctx.restore();
}

/** Jersey seen from one side: the torso slice around the flank and one sleeve pointing at the viewer. */
function sideView(ctx: CanvasRenderingContext2D, tex: HTMLCanvasElement, centreU: number): void {
  const W = 220;
  const w = TW * 0.62;
  const x0 = (W - w) / 2;
  const y0 = 34;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  ctx.beginPath();
  ctx.moveTo(x0 + 6, y0 + 6);
  ctx.quadraticCurveTo(x0 + w / 2, y0 - 6, x0 + w - 6, y0 + 6);
  ctx.lineTo(x0 + w + 4, y0 + TH);
  ctx.lineTo(x0 - 4, y0 + TH);
  ctx.closePath();
  ctx.fillStyle = '#000';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.save();
  ctx.clip();
  // the side shows about a third of the circumference, compressed like a cylinder seen from the side
  const slices = 48;
  const left = x0 - 4;
  const width = w + 8;
  for (let i = 0; i < slices; i++) {
    const a0 = -Math.PI / 2 + (i / slices) * Math.PI;
    const a1 = -Math.PI / 2 + ((i + 1) / slices) * Math.PI;
    const xa = left + ((Math.sin(a0) + 1) / 2) * width;
    const xb = left + ((Math.sin(a1) + 1) / 2) * width;
    const u = centreU + (a0 / (Math.PI * 2)) * 0.62;
    const du = ((a1 - a0) / (Math.PI * 2)) * 0.62;
    const uu = ((u % 1) + 1) % 1;
    ctx.drawImage(tex, uu * JERSEY_TEX, 0, Math.max(1, du * JERSEY_TEX), TORSO_H, xa, y0 - 8, xb - xa + 0.8, TH + 12);
    // cylinder shading
    ctx.fillStyle = `rgba(0,0,0,${0.18 * Math.abs(Math.sin((a0 + a1) / 2)) ** 2})`;
    ctx.fillRect(xa, y0 - 8, xb - xa + 0.8, TH + 12);
  }
  ctx.restore();
  // the sleeve over the shoulder, cuff at the bottom
  ctx.save();
  ctx.translate(x0 + w / 2 - SW * 0.42, y0 - 2);
  ctx.beginPath();
  ctx.roundRect(0, 0, SW * 0.84, SL + 6, [18, 18, 8, 8]);
  ctx.fillStyle = '#000';
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 6;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.clip();
  sleeveSlice(ctx, tex, (((centreU - 0.25) % 1) + 1) % 1, SW * 0.84, SL + 6);
  ctx.restore();
  ctx.restore();
}

function jerseyCard(j: JerseyItem): void {
  const tex = el('canvas');
  tex.width = JERSEY_TEX;
  tex.height = JERSEY_TEX;
  paintJersey(tex.getContext('2d')!, j.look.design);
  const views = card(j.model, `${j.look.design.pattern} · ${j.look.design.colors.join(' / ')}${j.inspiredBy ? ` · nach ${j.inspiredBy}` : ''}`, j.id);
  garment(view(views, 'Vorne', 340, 330), tex, 0.25, false);
  garment(view(views, 'Hinten', 340, 330), tex, 0.75, true);
  sideView(view(views, 'Links', 220, 330), tex, 0.5);
  sideView(view(views, 'Rechts', 220, 330), tex, 0);
  const t = view(views, 'Textur', 200, 200);
  t.drawImage(tex, 0, 0, 200, 200);
}

// -------------------------------------------------------------------------------------- wheels

function wheelSide(ctx: CanvasRenderingContext2D, rimTex: HTMLCanvasElement, w: WheelsItem, mirror: boolean): void {
  const size = 300;
  const R = BASE_SPEC.wheelRadius;
  const g = rimGeometry(R, BASE_SPEC.tyreWidth, w.rimDepthMm);
  const s = (size / 2 - 6) / R;
  const cx = size / 2;
  const cy = size / 2;
  const src = rimTex.getContext('2d')!.getImageData(0, 0, RIM_W, RIM_H).data;
  const img = ctx.createImageData(size * 2, size * 2);
  const tyre = [26, 26, 28];
  for (let py = 0; py < size * 2; py++) {
    for (let px = 0; px < size * 2; px++) {
      const x = (px / 2 - cx) / s;
      const y = (cy - py / 2) / s;
      const r = Math.hypot(x, y);
      const o = (py * size * 2 + px) * 4;
      if (r > R || r < g.inner) continue;
      if (r > g.bead) {
        const k = 0.85 + 0.25 * Math.sin(((r - g.bead) / (R - g.bead)) * Math.PI);
        img.data[o] = tyre[0]! * k;
        img.data[o + 1] = tyre[1]! * k;
        img.data[o + 2] = tyre[2]! * k;
        img.data[o + 3] = 255;
        continue;
      }
      // angle from the top, clockwise as seen from the drive side
      let u = Math.atan2(x, y) / (Math.PI * 2);
      u = ((u % 1) + 1) % 1;
      if (mirror) u = 1 - u;
      const tx = Math.min(RIM_W - 1, Math.floor(u * RIM_W));
      const ty = Math.min(RIM_H - 1, Math.floor(((g.bead - r) / g.depth) * RIM_H));
      const so = (ty * RIM_W + tx) * 4;
      img.data[o] = src[so]!;
      img.data[o + 1] = src[so + 1]!;
      img.data[o + 2] = src[so + 2]!;
      img.data[o + 3] = 255;
    }
  }
  const tmp = el('canvas');
  tmp.width = size * 2;
  tmp.height = size * 2;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  // spokes and hub under the rim
  ctx.strokeStyle = w.look.spoke;
  ctx.lineWidth = 1.6;
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 9, cy + Math.sin(a) * 9);
    ctx.lineTo(cx + Math.cos(a + (k % 2 ? 0.08 : -0.08)) * g.inner * s, cy + Math.sin(a + (k % 2 ? 0.08 : -0.08)) * g.inner * s);
    ctx.stroke();
  }
  ctx.fillStyle = w.look.hub;
  ctx.beginPath();
  ctx.arc(cx, cy, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#9aa0a6';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.drawImage(tmp, 0, 0, size, size);
}

/** Edge-on view (rider's view of the front wheel) and the rim section, to scale. */
function wheelEdge(ctx: CanvasRenderingContext2D, w: WheelsItem): void {
  const R = BASE_SPEC.wheelRadius;
  const g = rimGeometry(R, BASE_SPEC.tyreWidth, w.rimDepthMm);
  const s = 144 / R;
  const cx = 60;
  const tw = BASE_SPEC.tyreWidth / 2;
  const hw = 0.0125;
  ctx.fillStyle = '#1a1a1c';
  ctx.beginPath();
  ctx.roundRect(cx - tw * s, 6, tw * 2 * s, 2 * R * s, tw * s);
  ctx.fill();
  ctx.fillStyle = w.look.rim;
  for (const top of [true, false]) {
    const y = top ? 6 + (R - g.bead) * s : 6 + (R + g.inner) * s;
    ctx.fillRect(cx - hw * s, y, hw * 2 * s, g.depth * s);
  }
  ctx.fillStyle = w.look.hub;
  ctx.fillRect(cx - 0.05 * s, 6 + R * s - 6, 0.1 * s, 12);
}

function rimSection(ctx: CanvasRenderingContext2D, w: WheelsItem): void {
  const R = BASE_SPEC.wheelRadius;
  const g = rimGeometry(R, BASE_SPEC.tyreWidth, w.rimDepthMm);
  const s = 2600;
  const cx = 70;
  const top = 18;
  const hw = 0.0125;
  // tyre
  ctx.fillStyle = '#1d1d1f';
  ctx.beginPath();
  ctx.ellipse(cx, top + BASE_SPEC.tyreWidth * s * 0.5, (BASE_SPEC.tyreWidth / 2) * s, BASE_SPEC.tyreWidth * 0.5 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  // rim: the lathe profile of bike.ts
  const y0 = top + (R - g.bead) * s;
  const pts: Array<[number, number]> = [
    [hw, 0], [hw * 1.12, g.depth * 0.45], [hw * 0.7, g.depth - 0.006], [0, g.depth], [-hw * 0.7, g.depth - 0.006], [-hw * 1.12, g.depth * 0.45], [-hw, 0],
  ];
  ctx.fillStyle = w.look.rim;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(cx + x * s, y0 + y * s) : ctx.moveTo(cx + x * s, y0 + y * s)));
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#6b7280';
  ctx.font = '600 11px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(`${w.rimDepthMm} mm`, cx, y0 + g.depth * s + 18);
}

function wheelCard(w: WheelsItem): void {
  const g = rimGeometry(BASE_SPEC.wheelRadius, BASE_SPEC.tyreWidth, w.rimDepthMm);
  const rimTex = el('canvas');
  rimTex.width = RIM_W;
  rimTex.height = RIM_H;
  paintRim(rimTex.getContext('2d')!, w.look, g.depth, g.circ);
  const views = card(`${w.brand} ${w.model}`, `${w.rimDepthMm} mm · ${w.look.finish} · Decal „${w.look.decal.text}“ ${w.look.decal.style}${w.inspiredBy ? ` · nach ${w.inspiredBy}` : ''}`, w.id);
  wheelSide(view(views, 'Antriebsseite', 300, 300), rimTex, w, false);
  wheelSide(view(views, 'Gegenseite', 300, 300), rimTex, w, false);
  wheelEdge(view(views, 'Front', 120, 300), w);
  rimSection(view(views, 'Querschnitt', 140, 300), w);
  const t = view(views, 'Decal', 420, 60);
  t.drawImage(rimTex, 0, 0, RIM_W / 2, RIM_H, 0, 0, 420, 60);
}

const sheet = el('div', 'sheet');
document.body.append(el('h1', undefined, 'Design-Referenz: Trikots und Laufräder'), sheet);
await document.fonts.ready;
if (only !== 'wheels') await jerseyArtReady.then(() => JERSEYS.forEach(jerseyCard));
if (only !== 'jerseys') WHEELS.forEach(wheelCard);
document.body.dataset.ready = '1';
