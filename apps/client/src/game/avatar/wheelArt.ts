import type { WheelsItem } from '@velo/equipment';

export type WheelLook = WheelsItem['look'];

/**
 * Rim sidewall texture: x = u around the rim (one full turn), y = 0 at the tyre bead down to RIM_H at
 * the spoke bed. The same texture goes on both sidewalls (bike.ts mirrors u on the left side so the
 * lettering reads forwards on both). Lettering is drawn in metres and scaled per axis, so it keeps
 * its proportions on 22 mm and 65 mm rims alike.
 */
export const RIM_W = 4096;
export const RIM_H = 256;

const FONT = "'Inter', 'Helvetica Neue', Arial, sans-serif";
type Ctx = CanvasRenderingContext2D;

function hash(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Paints the sidewall of a rim `depthM` deep whose mid-depth circumference is `circM`.
 * The surface: anodised alloy with a fine machined grain, matte unidirectional carbon with
 * fibre streaks along the rim, or glossy carbon (smooth, the material adds the shine).
 */
export function paintRim(ctx: Ctx, look: WheelLook, depthM: number, circM: number): void {
  const sx = RIM_W / circM; // px per metre along the rim
  const sy = RIM_H / depthM; // px per metre across
  const [r, g, b] = rgb(look.rim);
  const img = ctx.createImageData(RIM_W, RIM_H);
  for (let y = 0; y < RIM_H; y++) {
    for (let x = 0; x < RIM_W; x++) {
      let k = 1;
      if (look.finish === 'carbon') {
        // UD fibre: thin streaks along the rim, a little blotchy
        k = 0.88 + 0.16 * hash(Math.floor(x / 23), y) + 0.05 * hash(Math.floor(x / 160), Math.floor(y / 3));
      } else if (look.finish === 'alu') {
        k = 0.94 + 0.1 * hash(x, Math.floor(y / 2));
      } else {
        k = 0.97 + 0.04 * hash(Math.floor(x / 40), Math.floor(y / 6));
      }
      // brake-track-like machined band at the bead on alloy rims
      if (look.finish === 'alu' && y < RIM_H * 0.16) k *= 1.9 + 0.2 * hash(x, y);
      const o = (y * RIM_W + x) * 4;
      img.data[o] = Math.min(255, r * k);
      img.data[o + 1] = Math.min(255, g * k);
      img.data[o + 2] = Math.min(255, b * k);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const d = look.decal;
  // letters in metres; ctx is scaled so 1 unit = 1 mm along the rim and the same across
  const mm = sx / 1000;
  const yScale = sy / sx;
  const capH = Math.min(depthM * (d.style === 'tonal' ? 0.34 : 0.62), 0.036) * 1000; // letter height, mm
  const centreY = RIM_H * (look.finish === 'alu' ? 0.56 : 0.46);
  for (let i = 0; i < d.count; i++) {
    const cx = ((i + 0.5) / d.count) * RIM_W;
    for (const dx of [-RIM_W, 0, RIM_W]) {
      ctx.save();
      ctx.translate(cx + dx, centreY);
      ctx.scale(mm, mm * yScale);
      drawDecal(ctx, d, capH);
      ctx.restore();
    }
  }
}

/** One wordmark with its model line, centred at the origin; units are millimetres on the rim. */
function drawDecal(ctx: Ctx, d: WheelLook['decal'], capH: number): void {
  const font = (h: number, weight: number, italic = false) => `${italic ? 'italic ' : ''}${weight} ${h}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const spacing = (px: number) => ((ctx as Ctx & { letterSpacing?: string }).letterSpacing = `${px}px`);
  // the letters' em box is taller than their caps: size the font so capitals are capH high
  const size = capH / 0.72;
  ctx.font = font(size, d.style === 'tonal' ? 600 : 900, d.style === 'italic');
  spacing(d.style === 'outline' ? size * 0.08 : size * 0.04);
  const w = ctx.measureText(d.text).width;
  const subSize = size * 0.3;

  if (d.style === 'stripe') {
    // band running into the wordmark from both sides, model line inside it
    ctx.fillStyle = d.accent;
    ctx.fillRect(-w * 1.9, capH * 0.56, w * 3.8, capH * 0.34);
  }
  if (d.style === 'italic') {
    // speed stripes in front of the wordmark
    ctx.fillStyle = d.accent;
    for (let k = 0; k < 3; k++) {
      const len = w * (0.5 - k * 0.12);
      ctx.save();
      ctx.transform(1, 0, -0.25, 1, 0, 0);
      ctx.fillRect(-w / 2 - len - 20, -capH * 0.42 + k * capH * 0.32, len, capH * 0.16);
      ctx.restore();
    }
  }
  if (d.style === 'outline') {
    ctx.lineWidth = capH * 0.07;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = d.color;
    ctx.strokeText(d.text, 0, 0);
  } else {
    ctx.fillStyle = d.color;
    ctx.fillText(d.text, 0, 0);
  }
  // model line after the wordmark, small and in the accent colour
  ctx.font = font(subSize, 700);
  spacing(subSize * 0.15);
  ctx.textAlign = 'left';
  ctx.fillStyle = d.style === 'tonal' ? d.color : d.accent;
  const y = d.style === 'stripe' ? capH * 0.74 : capH * 0.28;
  if (d.style === 'stripe') {
    ctx.fillStyle = '#111111';
    ctx.textAlign = 'center';
    ctx.fillText(d.sub, w * 1.25, y);
    ctx.fillText(d.sub, -w * 1.25, y);
  } else {
    ctx.fillText(d.sub, w / 2 + subSize * 0.8, y);
  }
}

/** Rim cross-section shared by the 3D wheel (bike.ts) and the reference sheet: radii in metres. */
export function rimGeometry(wheelRadius: number, tyreWidth: number, rimDepthMm: number) {
  const depth = Math.min(0.085, Math.max(0.02, rimDepthMm / 1000));
  const bead = wheelRadius - tyreWidth + 0.003;
  const inner = bead - depth;
  return { depth, bead, inner, circ: 2 * Math.PI * (bead - depth / 2) };
}
