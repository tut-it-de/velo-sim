import type { JerseyDesign } from '@velo/equipment';

/**
 * Jersey prints, painted on a canvas that the avatar's cloth shader samples (uv2, see cyclist.ts).
 *
 * Layout of the square texture (JERSEY_TEX px):
 * - torso, top 3/4: x = u around the body by arc length (0 right side, 0.25 chest, 0.5 left side,
 *   0.75 back), y = (1 − s) with s = 0 at the hem and s = 1 at the collar.
 * - sleeves, bottom 1/4: x = u around the arm, y = s from the shoulder (0) to the cuff (1).
 *
 * The torso is about 0.86 m around and 0.56 m long, a sleeve 0.31 m around and 0.15 m long, so
 * lettering is stretched by ASPECT to look right on the body. Everything wraps around in u.
 */
export const JERSEY_TEX = 1024;
export const TORSO_H = 768;
export const SLEEVE_H = JERSEY_TEX - TORSO_H;
/** Vertical stretch so text has its proportions on the torso and on the sleeves. */
const TORSO_ASPECT = 1.15;
const SLEEVE_ASPECT = 0.52;

const RAINBOW = ['#0057b8', '#e4002b', '#1d1d1d', '#ffd100', '#009639'];
const FONT = "'Inter', 'Helvetica Neue', Arial, sans-serif";

type Ctx = CanvasRenderingContext2D;

// ---------------------------------------------------------------------------- colour helpers

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function css([r, g, b]: [number, number, number], a = 1): string {
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}
function shade(hex: string, k: number, a = 1): string {
  const [r, g, b] = rgb(hex);
  return css([Math.min(255, r * k), Math.min(255, g * k), Math.min(255, b * k)], a);
}
function mix(a: string, b: string, t: number): [number, number, number] {
  const x = rgb(a);
  const y = rgb(b);
  return [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
}
/** Light colours get dark details and the other way round. */
function luma(hex: string): number {
  const [r, g, b] = rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// ---------------------------------------------------------------------------- noise (wraps in u)

function hash(x: number, y: number, z: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const sz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash(ix + dx, iy + dy, iz + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), sx), l(c(0, 1, 0), c(1, 1, 0), sx), sy),
    l(l(c(0, 0, 1), c(1, 0, 1), sx), l(c(0, 1, 1), c(1, 1, 1), sx), sy),
    sz,
  );
}
/** Fractal noise on the torso cylinder: u wraps, s runs along the body; `scale` in features per metre. */
function cylNoise(u: number, s: number, scale: number, octaves = 4): number {
  const R = 0.137;
  const a = u * Math.PI * 2;
  let x = Math.cos(a) * R * scale;
  let y = s * 0.56 * scale;
  let z = Math.sin(a) * R * scale;
  let sum = 0;
  let amp = 0.5;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise3(x + o * 17.3, y, z);
    x *= 2.03;
    y *= 2.03;
    z *= 2.03;
    amp *= 0.5;
  }
  return sum / (1 - 0.5 ** octaves);
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------- drawing helpers

const W = JERSEY_TEX;
const X = (u: number) => u * W;
const Y = (s: number) => (1 - s) * TORSO_H;

/** Runs `draw` three times shifted by −W, 0, +W so shapes crossing the side seam wrap around. */
function wrapped(ctx: Ctx, draw: () => void): void {
  for (const dx of [-W, 0, W]) {
    ctx.save();
    ctx.translate(dx, 0);
    draw();
    ctx.restore();
  }
}

/** Horizontal band on the torso between s0 and s1 (s0 < s1). */
function band(ctx: Ctx, s0: number, s1: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(0, Y(s1), W, Y(s0) - Y(s1));
}
/** Band on the sleeve from s0 to s1 (0 shoulder, 1 cuff). */
function sleeveBand(ctx: Ctx, s0: number, s1: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(0, TORSO_H + s0 * SLEEVE_H, W, (s1 - s0) * SLEEVE_H);
}

/** Wordmark centred at (u, s) on the torso, `h` = letter height in texture px. */
function wordmark(ctx: Ctx, text: string, u: number, s: number, h: number, color: string, opts: { weight?: number; spacing?: number; serif?: boolean } = {}): void {
  ctx.save();
  ctx.translate(X(u), Y(s));
  ctx.scale(1, TORSO_ASPECT);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${opts.weight ?? 800} ${h}px ${opts.serif ? "Georgia, 'Times New Roman', serif" : FONT}`;
  (ctx as Ctx & { letterSpacing?: string }).letterSpacing = `${opts.spacing ?? h * 0.18}px`;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/** The brand emblem: a "V" chevron in a rounded square, centred at (x, y) in texture px. */
function emblem(ctx: Ctx, x: number, y: number, size: number, color: string, aspect: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, aspect);
  ctx.strokeStyle = color;
  ctx.lineWidth = size * 0.16;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-size * 0.32, -size * 0.22);
  ctx.lineTo(0, size * 0.28);
  ctx.lineTo(size * 0.32, -size * 0.22);
  ctx.stroke();
  ctx.lineWidth = size * 0.07;
  ctx.strokeRect(-size * 0.5, -size * 0.5, size, size);
  ctx.restore();
}

// ---------------------------------------------------------------------------- patterns

interface Palette {
  base: string;
  second: string;
  trim: string;
  logo: string;
  /** Brand lettering, e.g. VELO or NAAP. */
  mark: string;
  /** The sleeve strip covers the whole arm down to the wrist. */
  longSleeve?: boolean;
}

/**
 * The brand's own lettering: VELO is wide and tracked, NAAP is a heavy, tight, forward-leaning
 * logotype like the one it is modelled on. `h` is the letter height in texture px.
 */
function brandMark(ctx: Ctx, p: Palette, u: number, s: number, h: number, color: string): void {
  if (p.mark === 'VELO') {
    wordmark(ctx, 'VELO', u, s, h, color, { spacing: h * 0.24 });
    return;
  }
  ctx.save();
  ctx.translate(X(u), Y(s));
  ctx.scale(1.18, TORSO_ASPECT);
  ctx.transform(1, 0, -0.22, 1, 0, 0);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `900 ${h}px ${FONT}`;
  (ctx as Ctx & { letterSpacing?: string }).letterSpacing = `${-h * 0.04}px`;
  ctx.fillText(p.mark, 0, 0);
  ctx.restore();
}

/** Lettering running down the outside of both sleeves, shoulder to cuff. */
function sleeveMark(ctx: Ctx, p: Palette, h: number, color: string, from = 0.12): void {
  for (const u of [0.25, 0.75]) {
    ctx.save();
    ctx.translate(X(u), TORSO_H + from * SLEEVE_H);
    ctx.scale(1, SLEEVE_ASPECT);
    ctx.rotate(Math.PI / 2);
    ctx.transform(1, 0, -0.22, 1, 0, 0);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${h}px ${FONT}`;
    (ctx as Ctx & { letterSpacing?: string }).letterSpacing = `${-h * 0.03}px`;
    ctx.fillText(p.mark, 0, 0);
    ctx.restore();
  }
}

/** Collar, hem gripper, back pockets, side seams, chest and back wordmarks: the same on every jersey. */
function details(ctx: Ctx, p: Palette, collar: string, backLogo = true, chestLogo = true): void {
  // collar and a soft shadow under it
  band(ctx, 0.935, 1, collar);
  band(ctx, 0.925, 0.935, shade(collar, 0.75));
  // silicone hem gripper
  band(ctx, 0, 0.028, shade(p.base, 0.72));
  band(ctx, 0.028, 0.034, shade(p.base, 1.15));
  // back pockets: three, with a reflective strip on top and seams between
  const dark = luma(p.base) > 0.5 ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.45)';
  const pocketTop = 0.27;
  ctx.fillStyle = dark;
  ctx.fillRect(X(0.75 - 0.135), Y(pocketTop) - 3, X(0.27), 5);
  ctx.fillStyle = 'rgba(235,238,242,0.85)';
  ctx.fillRect(X(0.75 - 0.135), Y(pocketTop) - 12, X(0.27), 6);
  ctx.fillStyle = dark;
  for (const du of [-0.045, 0.045]) ctx.fillRect(X(0.75 + du) - 1.5, Y(pocketTop), 3, Y(0.04) - Y(pocketTop));
  // flat-lock side seams
  ctx.fillStyle = dark;
  for (const u of [0, 0.5, 1]) ctx.fillRect(X(u) - 1, 0, 2, TORSO_H);
  // small chest wordmark on the left side, emblem on the right, big wordmark above the pockets
  if (chestLogo) brandMark(ctx, p, 0.36, 0.74, p.mark === 'VELO' ? 30 : 34, p.logo);
  if (chestLogo && p.mark === 'VELO') emblem(ctx, X(0.15), Y(0.74), 30, p.logo, TORSO_ASPECT);
  if (backLogo) brandMark(ctx, p, 0.75, 0.42, 58, p.logo);
  // tiny reflective tab at the left hem
  ctx.fillStyle = 'rgba(235,238,242,0.9)';
  ctx.fillRect(X(0.42), Y(0.08), 26, 10);
}

/** Sleeves: base colour, a contrasting laser-cut cuff and the emblem on the outside. */
function sleeves(ctx: Ctx, p: Palette, base: string, cuff: string): void {
  sleeveBand(ctx, 0, 1, base);
  sleeveBand(ctx, 0.82, 1, cuff);
  sleeveBand(ctx, 0.8, 0.82, shade(cuff, 0.7));
  if (p.mark === 'VELO') for (const u of [0.25, 0.75]) emblem(ctx, X(u), TORSO_H + 0.45 * SLEEVE_H, 44, p.logo, SLEEVE_ASPECT);
  else sleeveMark(ctx, p, 64, p.logo, 0.14);
}

function block(ctx: Ctx, p: Palette): void {
  band(ctx, 0, 1, p.base);
  // contrasting side panels, wider under the arms
  ctx.fillStyle = p.second;
  wrapped(ctx, () => {
    for (const u of [0, 0.5]) {
      ctx.beginPath();
      ctx.moveTo(X(u - 0.05), Y(0));
      ctx.lineTo(X(u - 0.075), Y(0.9));
      ctx.lineTo(X(u + 0.075), Y(0.9));
      ctx.lineTo(X(u + 0.05), Y(0));
      ctx.fill();
    }
  });
  details(ctx, p, p.trim);
  sleeves(ctx, p, p.base, p.trim);
}

function bandPattern(ctx: Ctx, p: Palette): void {
  band(ctx, 0, 1, p.base);
  band(ctx, 0.56, 0.69, p.second);
  band(ctx, 0.545, 0.553, p.second);
  band(ctx, 0.697, 0.705, p.second);
  details(ctx, p, p.second);
  // the chest band continues over the sleeves
  sleeves(ctx, p, p.base, p.second);
  sleeveBand(ctx, 0.15, 0.4, p.second);
}

function retro(ctx: Ctx, p: Palette): void {
  band(ctx, 0, 1, p.base);
  // knit: fine vertical ribs and a little fuzz
  for (let x = 0; x < W; x += 4) {
    ctx.fillStyle = `rgba(0,0,0,${0.05 + 0.04 * hash(x, 1, 2)})`;
    ctx.fillRect(x, 0, 2, JERSEY_TEX);
  }
  band(ctx, 0.6, 0.64, p.second);
  band(ctx, 0.68, 0.72, p.second);
  // button placket under the collar at the chest
  ctx.fillStyle = p.second;
  ctx.fillRect(X(0.25) - 7, Y(1), 14, Y(0.84) - Y(1));
  ctx.fillStyle = shade(p.second, 0.7);
  for (const s of [0.88, 0.92]) {
    ctx.beginPath();
    ctx.ellipse(X(0.25), Y(s), 5, 5 * TORSO_ASPECT, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  details(ctx, { ...p, logo: p.second }, p.second, false);
  // serif wordmark across the chest between the stripes, the club name on the back
  wordmark(ctx, 'VELO', 0.25, 0.495, 64, p.logo, { serif: true, weight: 700, spacing: 10 });
  wordmark(ctx, 'VELO CLUB', 0.75, 0.47, 44, p.second, { serif: true, weight: 700, spacing: 8 });
  sleeves(ctx, p, p.base, p.trim);
  sleeveBand(ctx, 0.7, 0.76, p.second);
}

function halftone(ctx: Ctx, p: Palette): void {
  band(ctx, 0, 1, p.base);
  // hexagonal grid that divides the width exactly so it wraps; dots shrink towards the chest
  const cols = 46;
  const dx = W / cols;
  const dy = dx * 0.87;
  ctx.fillStyle = p.second;
  for (let row = 0; row * dy < TORSO_H + dy; row++) {
    const y = TORSO_H - row * dy;
    const s = 1 - y / TORSO_H;
    for (let c = 0; c < cols; c++) {
      const u = (c + (row % 2) * 0.5) / cols;
      const wave = 0.08 * Math.sin(u * Math.PI * 4 + 0.6);
      const k = Math.min(1, Math.max(0, (0.62 + wave - s) / 0.55));
      const r = dx * 0.48 * k ** 1.3;
      if (r < 0.7) continue;
      wrapped(ctx, () => {
        ctx.beginPath();
        ctx.ellipse(X(u), y, r, r * TORSO_ASPECT, 0, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }
  details(ctx, p, p.trim);
  sleeves(ctx, p, p.base, p.second);
}

function topo(ctx: Ctx, p: Palette): void {
  const img = ctx.createImageData(W, TORSO_H);
  const base = rgb(p.base);
  const line = rgb(p.second);
  const index = rgb(p.trim);
  const levels = 22;
  // height field first, so the line width can be measured in pixels (value distance / gradient)
  const f = new Float32Array(W * TORSO_H);
  for (let y = 0; y < TORSO_H; y++) {
    const s = 1 - y / TORSO_H;
    for (let x = 0; x < W; x++) f[y * W + x] = cylNoise(x / W, s, 2.6, 3) * levels;
  }
  for (let y = 0; y < TORSO_H; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(TORSO_H - 1, y + 1);
    for (let x = 0; x < W; x++) {
      const v = f[y * W + x]!;
      const gx = (f[y * W + ((x + 1) % W)]! - f[y * W + ((x + W - 1) % W)]!) / 2;
      const gy = (f[y1 * W + x]! - f[y0 * W + x]!) / (y1 - y0);
      const grad = Math.max(1e-4, Math.hypot(gx, gy));
      const level = Math.round(v);
      const dist = Math.abs(v - level) / grad;
      const isIndex = level % 5 === 0;
      const a = Math.min(1, Math.max(0, (isIndex ? 2.1 : 1.15) + 0.5 - dist));
      const c = isIndex ? index : line;
      const o = (y * W + x) * 4;
      img.data[o] = base[0] + (c[0] - base[0]) * a;
      img.data[o + 1] = base[1] + (c[1] - base[1]) * a;
      img.data[o + 2] = base[2] + (c[2] - base[2]) * a;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  details(ctx, p, p.trim);
  sleeves(ctx, p, p.base, p.trim);
  // a few contour lines over the sleeves too
  ctx.strokeStyle = p.second;
  ctx.lineWidth = 3;
  for (let k = 0; k < 4; k++) {
    ctx.beginPath();
    for (let x = 0; x <= W; x += 8) {
      const y = TORSO_H + (0.12 + k * 0.17) * SLEEVE_H + Math.sin((x / W) * Math.PI * 4 + k) * 9;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

function gradient(ctx: Ctx, p: Palette): void {
  // shoulders in the base colour, into the second colour at the hem; ordered dither against banding
  const img = ctx.createImageData(W, TORSO_H);
  for (let y = 0; y < TORSO_H; y++) {
    const s = 1 - y / TORSO_H;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      // the fade rises a little towards the back, like a cut panel
      const edge = 0.5 + 0.06 * Math.cos((u - 0.75) * Math.PI * 2);
      let t = Math.min(1, Math.max(0, (edge + 0.32 - s) / 0.64));
      t = t * t * (3 - 2 * t);
      t += (hash(x, y, 7) - 0.5) / 255;
      const c = mix(p.base, p.second, Math.min(1, Math.max(0, t)));
      const o = (y * W + x) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // a fine pin line across the chest
  band(ctx, 0.805, 0.811, p.trim);
  const logo = { ...p, logo: p.trim };
  details(ctx, logo, p.trim);
  sleeves(ctx, logo, p.base, p.trim);
}

function polka(ctx: Ctx, p: Palette): void {
  band(ctx, 0, 1, p.base);
  const cols = 16;
  const dx = W / cols;
  const dy = dx * 0.9 / TORSO_ASPECT;
  ctx.fillStyle = p.second;
  for (let row = 0; row * dy < TORSO_H + dy; row++) {
    for (let c = 0; c < cols; c++) {
      const u = (c + (row % 2) * 0.5) / cols;
      wrapped(ctx, () => {
        ctx.beginPath();
        ctx.ellipse(X(u), TORSO_H - row * dy, dx * 0.21, dx * 0.21 * TORSO_ASPECT, 0, 0, Math.PI * 2);
        ctx.fill();
      });
    }
  }
  details(ctx, p, p.second);
  sleeves(ctx, p, p.base, p.second);
  ctx.fillStyle = p.second;
  for (let c = 0; c < 8; c++) {
    ctx.beginPath();
    ctx.ellipse(((c + 0.5) / 8) * W, TORSO_H + 0.35 * SLEEVE_H, 22, 22 * 1.9, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function fragment(ctx: Ctx, p: Palette): void {
  band(ctx, 0, 1, p.base);
  const rnd = seeded(7);
  // shards gathered along a band that climbs from the right hip over the chest to the left shoulder
  for (let k = 0; k < 140; k++) {
    const u = rnd();
    const centre = 0.25 + 0.3 * Math.sin((u - 0.05) * Math.PI * 2);
    const s = centre + (rnd() - 0.5) * 0.45;
    const size = 18 + rnd() * 70;
    const col = rnd() < 0.62 ? p.second : p.trim;
    const alpha = 0.55 + rnd() * 0.45;
    const pts: Array<[number, number]> = [];
    const n = 3 + Math.floor(rnd() * 2);
    const rot = rnd() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.9;
      const r = size * (0.5 + rnd() * 0.7);
      pts.push([X(u) + Math.cos(a) * r, Y(s) + Math.sin(a) * r * 0.75]);
    }
    ctx.fillStyle = shade(col, 1, alpha);
    wrapped(ctx, () => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
    });
  }
  details(ctx, p, p.base);
  sleeves(ctx, p, p.base, p.second);
}

function rainbow(ctx: Ctx, p: Palette): void {
  band(ctx, 0, 1, p.base);
  RAINBOW.forEach((c, i) => band(ctx, 0.56 + i * 0.032, 0.56 + (i + 1) * 0.032, c));
  details(ctx, p, p.base);
  RAINBOW.forEach((c, i) => band(ctx, 0.935 + i * 0.013, 0.935 + (i + 1) * 0.013, c));
  sleeves(ctx, p, p.base, p.base);
  RAINBOW.forEach((c, i) => sleeveBand(ctx, 0.72 + i * 0.05, 0.72 + (i + 1) * 0.05, c));
}

function split(ctx: Ctx, p: Palette): void {
  band(ctx, 0, 1, p.base);
  // wavy boundary that reads as a diagonal on the chest and the back
  const boundary = (u: number) => 0.46 + 0.16 * Math.sin(u * Math.PI * 2 + 0.4);
  ctx.fillStyle = p.second;
  ctx.beginPath();
  ctx.moveTo(0, TORSO_H);
  for (let x = 0; x <= W; x += 4) ctx.lineTo(x, Y(boundary(x / W)));
  ctx.lineTo(W, TORSO_H);
  ctx.fill();
  ctx.strokeStyle = p.trim;
  ctx.lineWidth = 7;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 4) {
    const y = Y(boundary(x / W)) - 10;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  details(ctx, p, p.second);
  sleeves(ctx, p, p.base, p.second);
}

/** Pro Air: dark base, fine stripes fading over the chest, side panels, huge slanted lettering. */
function athletic(ctx: Ctx, p: Palette): void {
  band(ctx, 0, 1, p.base);
  // fine horizontal stripes in the third colour, strongest across the chest and shoulders
  for (let y = 0; y < TORSO_H; y += 9) {
    const s = 1 - y / TORSO_H;
    const k = Math.min(1, Math.max(0, (s - 0.18) / 0.5));
    ctx.fillStyle = shade(p.trim, 1, 0.25 + 0.6 * k);
    ctx.fillRect(0, y, W, 4);
  }
  // mesh-dark side panels with a violet-ish inner edge
  ctx.fillStyle = shade(p.base, 0.7);
  wrapped(ctx, () => {
    for (const u of [0, 0.5]) {
      ctx.beginPath();
      ctx.moveTo(X(u - 0.06), Y(0));
      ctx.lineTo(X(u - 0.085), Y(0.92));
      ctx.lineTo(X(u + 0.085), Y(0.92));
      ctx.lineTo(X(u + 0.06), Y(0));
      ctx.fill();
    }
  });
  // claws rising from the hem on the front, like the race jersey's spikes
  ctx.fillStyle = p.second;
  for (const [u, dir] of [[0.18, 1], [0.32, -1]] as const) {
    ctx.beginPath();
    ctx.moveTo(X(u - 0.03 * dir), Y(0.04));
    ctx.quadraticCurveTo(X(u - 0.01 * dir), Y(0.3), X(u + 0.035 * dir), Y(0.46));
    ctx.quadraticCurveTo(X(u + 0.005 * dir), Y(0.26), X(u + 0.012 * dir), Y(0.04));
    ctx.fill();
  }
  // the big lettering: two lines leaning across the chest, again on the back
  const big = (u: number, s: number, h: number, text: string) => {
    ctx.save();
    ctx.translate(X(u), Y(s));
    ctx.scale(1, TORSO_ASPECT);
    ctx.rotate(-0.16);
    ctx.transform(1, 0, -0.25, 1, 0, 0);
    ctx.fillStyle = p.second;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${h}px ${FONT}`;
    (ctx as Ctx & { letterSpacing?: string }).letterSpacing = `${-h * 0.05}px`;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  };
  wrapped(ctx, () => {
    big(0.24, 0.72, 120, p.mark);
    big(0.26, 0.58, 92, 'ATHLETIC');
    big(0.75, 0.7, 110, p.mark);
    big(0.76, 0.57, 84, 'ATHLETIC');
  });
  details(ctx, { ...p, logo: p.second }, p.base, false, false);
  // sleeves: stripes, a dark cuff and the lettering down the outside
  sleeveBand(ctx, 0, 1, p.base);
  for (let y = 0; y < SLEEVE_H; y += 9) {
    ctx.fillStyle = shade(p.trim, 1, 0.75 - 0.5 * (y / SLEEVE_H));
    ctx.fillRect(0, TORSO_H + y, W, 4);
  }
  sleeveBand(ctx, 0.86, 1, shade(p.base, 0.8));
  sleeveMark(ctx, p, 150, p.second, 0.04);
}

/**
 * Pro Air 3.0 "Mental Athletic": black halftone mesh, a teal field on the upper chest, two lines of
 * huge slanted lettering on a band, claw brackets below; a yoke arc over the back, lettering at the waist.
 */
function athletic3(ctx: Ctx, p: Palette): void {
  const acc = p.second;
  const plum = p.trim;
  const sp = ctx as Ctx & { letterSpacing?: string };
  // the mesh tone: teal next to a green accent, a cooler grey-green next to a violet one
  const [, ag, ab] = rgb(acc);
  const cool = Math.min(1, Math.max(0, (ab - ag) / 70 + 0.4));
  const meshHex = '#' + mix('#1b5f6a', '#45544d', cool).map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
  const mesh = (a: number) => shade(meshHex, 1, a);
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const c = 0.25;
  const b = 0.75;
  /** Dash rows (the printed mesh) between y0 and y1 in texture px; `k` 0…1 sets dash height and strength. */
  const dashes = (y0: number, y1: number, k: (x: number, y: number) => number, color: (a: number) => string, step = 10, colW = 18) => {
    for (let y = y0, row = 0; y < y1; y += step, row++) {
      for (let x = (row % 2) * colW * 0.5 - colW; x < W + colW; x += colW) {
        const kk = k(x, y);
        if (kk <= 0.02) continue;
        const h = 1 + 5 * kk;
        ctx.fillStyle = color(0.25 + 0.75 * kk);
        ctx.fillRect(x, y + (step - h) / 2, colW * 0.62, h);
      }
    }
  };
  const path = (pts: [number, number][], du = 0, d = 1) => {
    ctx.beginPath();
    pts.forEach(([x, s], i) => (i ? ctx.lineTo(X(du + d * x), Y(s)) : ctx.moveTo(X(du + d * x), Y(s))));
    ctx.closePath();
  };
  // big italic lettering, left-aligned at (u, s); `clip` limits it to [u0, u1]
  const big = (text: string, u: number, s: number, h: number, u0: number, u1: number) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(X(u0), 0, X(u1 - u0), TORSO_H);
    ctx.clip();
    ctx.translate(X(u), Y(s));
    ctx.scale(1.22, TORSO_ASPECT);
    ctx.transform(1, 0, -0.3, 1, 0, 0);
    ctx.fillStyle = acc;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${h}px ${FONT}`;
    sp.letterSpacing = `${-h * 0.05}px`;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  };

  band(ctx, 0, 1, p.base);
  // mesh all over: strongest down the middle of the front and back, faint on the flanks, fading to the hem
  dashes(0, TORSO_H, (x, y) => {
    const u = (((x / W) % 1) + 1) % 1;
    const s = 1 - y / TORSO_H;
    const fc = Math.abs(u - c);
    const bc = Math.abs(u - b);
    const k = fc < 0.17 ? 0.25 + 0.6 * clamp(1 - fc / 0.12) : bc < 0.17 ? 0.2 + 0.5 * clamp(1 - bc / 0.12) : 0.18;
    return k * (0.3 + 0.7 * clamp(s / 0.55));
  }, mesh);
  // plum side panels
  ctx.fillStyle = plum;
  wrapped(ctx, () => {
    for (const u of [0, 0.5]) {
      path([[-0.022, 0.05], [-0.03, 0.6], [0.03, 0.6], [0.022, 0.05]], u);
      ctx.fill();
    }
  });

  // --- front: teal field under the collar, framed by accent shoulder wedges
  const field = (top: number, bottom: number, u0: number, u1: number) => {
    ctx.fillStyle = mesh(0.85);
    ctx.fillRect(X(u0), Y(top), X(u1 - u0), Y(bottom) - Y(top));
    ctx.save();
    ctx.beginPath();
    ctx.rect(X(u0), Y(top), X(u1 - u0), Y(bottom) - Y(top));
    ctx.clip();
    dashes(Y(top), Y(bottom), (_x, y) => 0.25 + 0.6 * clamp((Y(bottom) - y) / (Y(bottom) - Y(top))), (a) => shade(p.base, 1, a * 0.5), 12, 22);
    ctx.restore();
  };
  field(0.94, 0.72, c - 0.14, c + 0.14);
  const wedges = (u: number, s0: number) => {
    for (const d of [-1, 1]) {
      ctx.fillStyle = acc;
      ctx.beginPath();
      ctx.moveTo(X(u + d * 0.065), Y(0.94));
      ctx.quadraticCurveTo(X(u + d * 0.105), Y(0.9), X(u + d * 0.112), Y(s0));
      ctx.lineTo(X(u + d * 0.15), Y(s0));
      ctx.lineTo(X(u + d * 0.15), Y(0.94));
      ctx.closePath();
      ctx.fill();
      // halftone fringe along the inner edge
      for (let i = 0; i < 9; i++) {
        const t = i / 8;
        const s = 0.935 - t * (0.935 - s0);
        const ue = u + d * (0.065 + 0.047 * Math.sqrt(t));
        for (let j = 1; j < 4; j++) {
          ctx.beginPath();
          ctx.arc(X(ue - d * j * 0.007), Y(s), 4.2 - j * 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  };
  wedges(c, 0.745);
  // the chest band and the two lines of lettering
  ctx.fillStyle = plum;
  ctx.fillRect(X(c - 0.3), Y(0.75), X(0.6), Y(0.565) - Y(0.75));
  ctx.fillRect(X(c - 0.3) + W, Y(0.75), X(0.6), Y(0.565) - Y(0.75));
  big('Mental', c - 0.125, 0.705, 92, c - 0.2, 0.47);
  big('Athletic', c - 0.115, 0.61, 92, c - 0.2, 0.47);

  // the two claw brackets, mirrored about the zip
  for (const d of [-1, 1]) {
    const outline = () =>
      path([[0.02, 0.53], [0.1, 0.55], [0.112, 0.52], [0.112, 0.44], [0.088, 0.405], [0.112, 0.37], [0.112, 0.1], [0.095, 0.075], [0.045, 0.1], [0.026, 0.14], [0.026, 0.25], [0.06, 0.315], [0.026, 0.37], [0.02, 0.52]], c, d);
    outline();
    ctx.fillStyle = p.base;
    ctx.fill();
    ctx.save();
    outline();
    ctx.clip();
    dashes(Y(0.57), Y(0.07), (_x, y) => 0.35 + 0.3 * Math.sin(y / 40), mesh, 11, 16);
    // accent halftone rising from the bottom
    ctx.fillStyle = acc;
    for (let y = Y(0.07); y > Y(0.3); y -= 9) {
      const k = (y - Y(0.3)) / (Y(0.07) - Y(0.3));
      for (let x = X(c + d * 0.02) - 160; x < X(c + d * 0.02) + 160; x += 9) {
        ctx.beginPath();
        ctx.arc(x + ((y / 9) % 2) * 4.5, y, 4.4 * k ** 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // the claw: solid at the base, breaking into dots towards the root
    ctx.beginPath();
    ctx.moveTo(X(c + d * 0.05), Y(0.33));
    ctx.quadraticCurveTo(X(c + d * 0.095), Y(0.2), X(c + d * 0.05), Y(0.085));
    ctx.quadraticCurveTo(X(c + d * 0.07), Y(0.2), X(c + d * 0.035), Y(0.31));
    ctx.closePath();
    const g = ctx.createLinearGradient(0, Y(0.33), 0, Y(0.15));
    g.addColorStop(0, shade(acc, 1, 0.15));
    g.addColorStop(1, acc);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
    outline();
    ctx.strokeStyle = acc;
    ctx.lineWidth = 6;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // --- back: plum yoke arc around a teal centre panel, accent wedges and curved lines, lettering at the waist
  ctx.fillStyle = plum;
  ctx.beginPath();
  ctx.moveTo(X(b - 0.11), Y(0.94));
  ctx.bezierCurveTo(X(b - 0.1), Y(0.8), X(b - 0.06), Y(0.66), X(b - 0.05), Y(0.55));
  ctx.lineTo(X(b + 0.05), Y(0.55));
  ctx.bezierCurveTo(X(b + 0.06), Y(0.66), X(b + 0.1), Y(0.8), X(b + 0.11), Y(0.94));
  ctx.closePath();
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(X(b - 0.045), Y(0.45));
  ctx.lineTo(X(b - 0.05), Y(0.78));
  ctx.bezierCurveTo(X(b - 0.05), Y(0.9), X(b + 0.05), Y(0.9), X(b + 0.05), Y(0.78));
  ctx.lineTo(X(b + 0.045), Y(0.45));
  ctx.closePath();
  ctx.clip();
  field(0.9, 0.45, b - 0.06, b + 0.06);
  ctx.restore();
  wedges(b, 0.8);
  ctx.strokeStyle = acc;
  ctx.lineCap = 'round';
  for (const d of [-1, 1]) {
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(X(b + d * 0.13), Y(0.82));
    ctx.bezierCurveTo(X(b + d * 0.07), Y(0.7), X(b + d * 0.055), Y(0.56), X(b + d * 0.035), Y(0.46));
    ctx.stroke();
    // a small arrowhead outline on the shoulder blade
    ctx.lineWidth = 4;
    path([[0.095, 0.74], [0.135, 0.7], [0.135, 0.6], [0.105, 0.64]], b, d);
    ctx.stroke();
    // accent halftone trailing down to the lettering
    ctx.fillStyle = acc;
    for (let i = 0; i < 14; i++) {
      const t = i / 13;
      for (let j = 0; j < 5; j++) {
        ctx.beginPath();
        ctx.arc(X(b + d * (0.035 + 0.012 * t + j * 0.008)), Y(0.47 + t * 0.12), 4.5 * (1 - t) * (1 - j / 5), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.fillStyle = plum;
  ctx.fillRect(X(b - 0.16), Y(0.46), X(0.32), Y(0.3) - Y(0.46));
  ctx.save();
  ctx.beginPath();
  ctx.rect(X(0.55), 0, X(0.4), TORSO_H);
  ctx.clip();
  big('Mental', b - 0.14, 0.42, 82, 0.55, 0.95);
  big('Athletic', b - 0.13, 0.335, 82, 0.55, 0.95);
  ctx.restore();
  details(ctx, { ...p, logo: acc }, p.base, false, false);
  // small spaced mark under the back collar
  ctx.save();
  ctx.translate(X(b), Y(0.905));
  ctx.scale(1, TORSO_ASPECT);
  ctx.fillStyle = acc;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `800 16px ${FONT}`;
  sp.letterSpacing = '9px';
  ctx.fillText(p.mark, 0, 0);
  ctx.restore();

  // --- sleeves: mesh, the word running down the outside, the spaced mark on the inside
  const long = !!p.longSleeve;
  sleeveBand(ctx, 0, 1, p.base);
  ctx.save();
  ctx.beginPath();
  // the top few percent stay plain: the shoulder cap samples the strip there
  ctx.rect(0, TORSO_H + 0.05 * SLEEVE_H, W, SLEEVE_H);
  ctx.clip();
  dashes(TORSO_H, JERSEY_TEX, (_x, y) => 0.6 - 0.4 * ((y - TORSO_H) / SLEEVE_H), mesh, long ? 4 : 8, 18);
  const vert = (text: string, u: number, from: number, h: number, asp: number, spacing: number, skew: number) => {
    ctx.save();
    ctx.translate(X(u), TORSO_H + from * SLEEVE_H);
    ctx.scale(1, asp);
    ctx.rotate(Math.PI / 2);
    ctx.transform(1, 0, skew, 1, 0, 0);
    ctx.fillStyle = acc;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${h}px ${FONT}`;
    sp.letterSpacing = `${spacing}px`;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  };
  // a long sleeve's strip spans ~3× the length, so the lettering is squeezed along it to keep its shape
  vert('Athletic', 0.25, 0.06, 340, long ? 0.13 : 0.3, -16, -0.3);
  vert(p.mark.split('').join(' '), 0.75, 0.1, 170, long ? 0.1 : 0.22, 40, -0.2);
  ctx.restore();
  if (!long) sleeveBand(ctx, 0.9, 1, shade(p.base, 0.85));
}

/** Apex Aeon: one solid colour, tonal side panels, the lettering only on the sleeves. */
function tonal(ctx: Ctx, p: Palette): void {
  band(ctx, 0, 1, p.base);
  // a very fine knit texture
  for (let y = 0; y < TORSO_H; y += 3) {
    ctx.fillStyle = shade(p.base, y % 6 ? 0.985 : 1.02);
    ctx.fillRect(0, y, W, 1);
  }
  ctx.fillStyle = p.second;
  wrapped(ctx, () => {
    for (const u of [0, 0.5]) {
      ctx.beginPath();
      ctx.moveTo(X(u - 0.045), Y(0));
      ctx.bezierCurveTo(X(u - 0.06), Y(0.4), X(u - 0.09), Y(0.75), X(u - 0.06), Y(0.93));
      ctx.lineTo(X(u + 0.06), Y(0.93));
      ctx.bezierCurveTo(X(u + 0.09), Y(0.75), X(u + 0.06), Y(0.4), X(u + 0.045), Y(0));
      ctx.fill();
    }
  });
  // small tonal mark at the left hip instead of a chest logo
  brandMark(ctx, { ...p }, 0.33, 0.12, 26, p.trim);
  details(ctx, { ...p, logo: p.trim }, p.trim, false);
  sleeveBand(ctx, 0, 1, p.base);
  sleeveBand(ctx, 0.84, 1, p.second);
  sleeveMark(ctx, p, 130, p.logo, 0.1);
}

/** Pro Aero Beta: light base, a cluster of brand stamps on the chest, halftone fading into the sleeves. */
function stamps(ctx: Ctx, p: Palette): void {
  band(ctx, 0, 1, p.base);
  const ink = p.second;
  // halftone rising from the hem
  const cols = 64;
  const dx = W / cols;
  ctx.fillStyle = shade(ink, 1, 0.55);
  for (let row = 0; row * dx * 0.87 < TORSO_H * 0.35; row++) {
    const y = TORSO_H - row * dx * 0.87;
    const k = 1 - (row * dx * 0.87) / (TORSO_H * 0.35);
    for (let c = 0; c < cols; c++) {
      const r = dx * 0.42 * k ** 1.6;
      if (r < 0.6) continue;
      ctx.beginPath();
      ctx.arc(((c + (row % 2) * 0.5) / cols) * W, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const rnd = seeded(31);
  const text = (u: number, s: number, h: number, t: string, weight = 900, skew = -0.2) => {
    ctx.save();
    ctx.translate(X(u), Y(s));
    ctx.scale(1, TORSO_ASPECT);
    ctx.transform(1, 0, skew, 1, 0, 0);
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${weight} ${h}px ${FONT}`;
    (ctx as Ctx & { letterSpacing?: string }).letterSpacing = `${weight < 800 ? h * 0.12 : -h * 0.04}px`;
    ctx.fillText(t, 0, 0);
    ctx.restore();
  };
  // front only: one big mark with a ruled line, then a tidy grid of smaller stamps under it
  const c = 0.25;
  text(c, 0.74, 74, p.mark);
  ctx.fillStyle = ink;
  ctx.fillRect(X(c - 0.085), Y(0.685), X(0.17), 5);
  text(c, 0.66, 14, 'PERFORMANCE ENGINEERING', 700, 0);
  // row 1: stacked bars, a ring, a boxed label
  for (let i = 0; i < 4; i++) ctx.fillRect(X(c - 0.1), Y(0.6) + i * 12, 64 - i * 12, 7);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.ellipse(X(c + 0.005), Y(0.575), 30, 17, -0.2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 4;
  ctx.strokeRect(X(c + 0.045), Y(0.6), 80, 34);
  text(c + 0.045 + 40 / W, 0.6 - 17 / TORSO_H, 18, 'BETA', 800, 0);
  // row 2: three small marks
  for (const du of [-0.07, 0, 0.07]) text(c + du, 0.49, 24, p.mark);
  text(c, 0.445, 11, 'N  A  A  P   ·   R A C E   L A B', 700, 0);
  // back: just a small mark above the pockets
  text(0.75, 0.4, 34, p.mark);
  void rnd;
  // pin stripes over the shoulders
  band(ctx, 0.88, 0.886, ink);
  band(ctx, 0.9, 0.904, ink);
  details(ctx, { ...p, logo: ink }, p.base, false, false);
  // sleeves: light at the shoulder, halftone getting denser towards the cuff, lettering on top
  sleeveBand(ctx, 0, 1, p.base);
  ctx.fillStyle = shade(ink, 1, 0.6);
  for (let row = 0; row < 18; row++) {
    const y = TORSO_H + (row / 18) * SLEEVE_H;
    const k = row / 17;
    for (let c = 0; c < 96; c++) {
      const r = 4.6 * k ** 1.4;
      if (r < 0.5) continue;
      ctx.beginPath();
      ctx.ellipse(((c + (row % 2) * 0.5) / 96) * W, y, r, r / SLEEVE_ASPECT / 1.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  sleeveBand(ctx, 0.9, 1, ink);
  sleeveMark(ctx, p, 70, ink, 0.08);
}

/** Evade Pro Base: plain light jersey, small chest lettering, a striped badge on the sleeve. */
function basePattern(ctx: Ctx, p: Palette): void {
  band(ctx, 0, 1, p.base);
  // raglan seams from the side up to the collar
  ctx.strokeStyle = p.trim;
  ctx.lineWidth = 3;
  wrapped(ctx, () => {
    for (const u of [0, 0.5]) {
      for (const d of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(X(u + d * 0.07), Y(0.86));
        ctx.quadraticCurveTo(X(u + d * 0.12), Y(0.9), X(u + d * 0.16), Y(0.94));
        ctx.stroke();
      }
    }
  });
  details(ctx, { ...p, logo: p.second }, p.base, false);
  // a short lettering at the lower back, like the reflective print
  brandMark(ctx, p, 0.75, 0.38, 30, p.second);
  sleeveBand(ctx, 0, 1, p.base);
  sleeveBand(ctx, 0.88, 1, p.trim);
  // the badge: five bars on the outside of each sleeve
  ctx.fillStyle = p.second;
  for (const u of [0.25, 0.75]) {
    for (let i = 0; i < 5; i++) ctx.fillRect(X(u) - 44, TORSO_H + (0.42 + i * 0.07) * SLEEVE_H, 88, 0.04 * SLEEVE_H);
  }
}

const PATTERNS: Record<JerseyDesign['pattern'], (ctx: Ctx, p: Palette) => void> = {
  block,
  band: bandPattern,
  retro,
  halftone,
  topo,
  gradient,
  polka,
  fragment,
  rainbow,
  split,
  athletic,
  tonal,
  stamps,
  base: basePattern,
  athletic3,
};

/** Paints the whole jersey texture (torso and sleeves) into a JERSEY_TEX² context. */
export function paintJersey(ctx: Ctx, design: JerseyDesign): void {
  const [base, second, trim] = design.colors;
  const p: Palette = { base, second, trim, logo: design.logo, mark: design.mark ?? 'VELO', longSleeve: design.longSleeve };
  ctx.save();
  ctx.clearRect(0, 0, W, JERSEY_TEX);
  PATTERNS[design.pattern](ctx, p);
  // light fabric grain over everything
  ctx.save();
  for (let k = 0; k < 9000; k++) {
    const h = hash(k, 3, 9);
    ctx.fillStyle = h > 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.035)';
    ctx.fillRect(hash(k, 1, 5) * W, hash(k, 2, 6) * JERSEY_TEX, 2, 2);
  }
  ctx.restore();
  ctx.restore();
}

/** Texture coordinate (0…1, v up) of a torso point; `s` 0 hem … 1 collar, `u` around by arc length. */
export function torsoUv(u: number, s: number): [number, number] {
  const v = 1 - Y(Math.min(1, Math.max(0, s))) / JERSEY_TEX;
  return [u, v];
}

/** Texture coordinate of a sleeve point; `s` 0 shoulder … 1 cuff. */
export function sleeveUv(u: number, s: number): [number, number] {
  const y = TORSO_H + Math.min(1, Math.max(0, s)) * (SLEEVE_H - 2) + 1;
  return [u, 1 - y / JERSEY_TEX];
}
