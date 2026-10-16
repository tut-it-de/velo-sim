import { DynamicTexture, Texture, type Scene } from '@babylonjs/core';
import { createRng } from '../noise';
import type { Architecture } from './worldData';

function canvasTexture(scene: Scene, name: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, hasAlpha = false): DynamicTexture {
  const tex = new DynamicTexture(name, { width: w, height: h }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  draw(ctx, w, h);
  tex.update(false);
  tex.hasAlpha = hasAlpha;
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

function speckle(ctx: CanvasRenderingContext2D, rng: () => number, x0: number, x1: number, h: number, count: number, base: number, spread: number, size = 2): void {
  for (let i = 0; i < count; i++) {
    const g = base + Math.floor((rng() - 0.5) * spread);
    ctx.fillStyle = `rgb(${g},${g},${g + 2})`;
    ctx.fillRect(x0 + rng() * (x1 - x0), rng() * h, size, size);
  }
}

/** Centre line dashes of rural roads, m: Italy 4.5 / 7.5, Germany 6 / 12, France 3 / 10 (French Alps). */
export const ROAD_MARKINGS: Record<Architecture, { dash: number; period: number }> = {
  italian: { dash: 4.5, period: 12 },
  german: { dash: 6, period: 18 },
  alpine: { dash: 3, period: 13 },
};

/** Length of road one repeat of the road texture covers (two dash periods), m. */
export const roadTextureRepeat = (style: Architecture) => 2 * ROAD_MARKINGS[style].period;

/**
 * Asphalt across the full road width (u: 0–0.06 shoulder, 0.06–0.94 asphalt, 0.94–1 shoulder) over
 * two dash periods of the country's centre line. Open road: white edge lines and centre dashes.
 * Town: kerbstones, patched asphalt, no centre line.
 */
export function roadTexture(scene: Scene, town: boolean, style: Architecture = 'italian'): DynamicTexture {
  const { dash: dashM, period } = ROAD_MARKINGS[style];
  return canvasTexture(scene, town ? 'road-town-tex' : `road-tex-${style}`, 512, 1024, (ctx, w, h) => {
    const rng = createRng(town ? 77 : 42);
    const px = (u: number) => Math.round(u * w);
    const a0 = px(0.06);
    const a1 = px(0.94);
    ctx.fillStyle = town ? '#a29d94' : '#7f776a';
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, rng, 0, a0, h, 900, town ? 150 : 120, 50);
    speckle(ctx, rng, a1, w, h, 900, town ? 150 : 120, 50);
    if (town) {
      ctx.fillStyle = 'rgba(60,60,60,0.5)';
      for (let y = 0; y < h; y += 43) {
        ctx.fillRect(0, y, a0, 2);
        ctx.fillRect(a1, y, w - a1, 2);
      }
    }
    ctx.fillStyle = town ? '#3f4042' : '#434548';
    ctx.fillRect(a0, 0, a1 - a0, h);
    speckle(ctx, rng, a0, a1, h, 26000, town ? 64 : 70, 30);
    // tyre tracks (slightly polished) and patches
    for (const u of [0.24, 0.39, 0.61, 0.76]) {
      const g = ctx.createLinearGradient(px(u - 0.05), 0, px(u + 0.05), 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.5, 'rgba(25,25,28,0.22)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(px(u - 0.05), 0, px(0.1), h);
    }
    for (let i = 0; i < (town ? 7 : 3); i++) {
      const g = 52 + Math.floor(rng() * 22);
      ctx.fillStyle = `rgba(${g},${g},${g + 3},0.75)`;
      ctx.fillRect(a0 + rng() * (a1 - a0 - 80), rng() * h, 30 + rng() * 90, 20 + rng() * 120);
    }
    ctx.strokeStyle = 'rgba(28,28,30,0.55)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      let x = a0 + rng() * (a1 - a0);
      let y = rng() * h;
      ctx.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        x += (rng() - 0.5) * 40;
        y += rng() * 40;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.fillStyle = town ? 'rgba(225,225,220,0.55)' : 'rgba(235,235,230,0.92)';
    const lw = 9;
    ctx.fillRect(px(0.075), 0, lw, h);
    ctx.fillRect(px(0.925) - lw, 0, lw, h);
    if (!town) {
      const dash = (dashM / (2 * period)) * h;
      for (let k = 0; k < 2; k++) ctx.fillRect(w / 2 - lw / 2, k * (h / 2) + h / 8, lw, dash);
    }
  });
}

/** Rough natural-stone masonry (2.5 m × 2.5 m per repeat) for lake walls and retaining walls. */
export function stoneTexture(scene: Scene): DynamicTexture {
  const tex = canvasTexture(scene, 'stone-tex', 256, 256, (ctx, w, h) => {
    const rng = createRng(9);
    ctx.fillStyle = '#5f5a52';
    ctx.fillRect(0, 0, w, h);
    let y = 0;
    while (y < h) {
      const rowH = 16 + Math.floor(rng() * 14);
      let x = -Math.floor(rng() * 40);
      while (x < w) {
        const sw = 26 + Math.floor(rng() * 44);
        const g = 128 + Math.floor(rng() * 40);
        const warm = Math.floor(rng() * 14);
        ctx.fillStyle = `rgb(${g + warm},${g + warm - 4},${g - 10})`;
        const draw = (ox: number) => {
          ctx.beginPath();
          ctx.roundRect(x + ox + 1.5, y + 1.5, sw - 3, Math.min(rowH, h - y) - 3, 4);
          ctx.fill();
        };
        draw(0);
        if (x + sw > w) draw(-w);
        x += sw;
      }
      y += rowH;
    }
    speckle(ctx, rng, 0, w, h, 2500, 120, 70, 1);
  });
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/** Plaster with fine grain and faint rain streaks, near-white so the vertex colour sets the paint. */
function plaster(ctx: CanvasRenderingContext2D, rng: () => number, w: number, h: number, streaks: number): void {
  ctx.fillStyle = '#f1ece3';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 9000; i++) {
    const g = 220 + Math.floor(rng() * 30);
    ctx.fillStyle = `rgba(${g},${g - 4},${g - 10},0.5)`;
    ctx.fillRect(rng() * w, rng() * h, 2, 2);
  }
  for (let i = 0; i < streaks; i++) {
    const x = rng() * w;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(120,110,95,0)');
    g.addColorStop(1, 'rgba(120,110,95,0.12)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, 6 + rng() * 20, h);
  }
}

/** Glazing with a sky reflection gradient. */
function glass(ctx: CanvasRenderingContext2D, x0: number, top: number, ww: number, wh: number): void {
  const g = ctx.createLinearGradient(x0, top, x0 + ww, top + wh);
  g.addColorStop(0, '#59697a');
  g.addColorStop(0.45, '#2c3540');
  g.addColorStop(1, '#1c2229');
  ctx.fillStyle = g;
  ctx.fillRect(x0, top, ww, wh);
}

/** Louvred shutter leaf. */
function shutter(ctx: CanvasRenderingContext2D, sx: number, top: number, sw: number, bottom: number, color: string, slat: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(sx, top, sw, bottom - top);
  ctx.fillStyle = slat;
  for (let y = top + 4; y < bottom; y += 6) ctx.fillRect(sx + 2, y, sw - 4, 2);
}

/**
 * Plastered facade, two window axes × two floors (7.2 m × 6.2 m), near-white so the per-building
 * vertex colour sets the paint. Italian: green shutters, stone sills and a string course. German:
 * white window frames with a mullion cross, roller shutter boxes, aluminium sills. Alpine: brown
 * wooden shutters and a wooden balcony along the upper floor.
 */
export function facadeTexture(scene: Scene, style: Architecture = 'italian'): DynamicTexture {
  const tex = canvasTexture(scene, `facade-tex-${style}`, 512, 512, (ctx, w, h) => {
    const rng = createRng(5);
    const mx = w / 7.2;
    const my = h / 6.2;
    plaster(ctx, rng, w, h, style === 'german' ? 6 : 14);
    if (style === 'italian') {
      // string course at each floor line (canvas y grows downwards: floor lines at 0, 3.1 m, 6.2 m)
      ctx.fillStyle = 'rgba(205,198,186,1)';
      for (const fy of [0, 3.1]) ctx.fillRect(0, h - (fy + 0.02) * my - 5, w, 6);
    }
    for (let floor = 0; floor < 2; floor++) {
      for (let col = 0; col < 2; col++) {
        const cx = (col + 0.5) * 3.6 * mx;
        const bottom = h - (floor * 3.1 + 0.95) * my;
        const top = h - (floor * 3.1 + 2.35) * my;
        const ww = (style === 'german' ? 1.15 : 1.0) * mx;
        const x0 = cx - ww / 2;
        const wh = bottom - top;
        if (style === 'italian') {
          const closed = (floor + col * 3) % 4 === 1;
          const green = (sx: number, sw: number) => shutter(ctx, sx, top, sw, bottom, '#4d6a48', 'rgba(20,35,20,0.45)');
          if (closed) {
            green(x0, ww / 2 - 1);
            green(x0 + ww / 2 + 1, ww / 2 - 1);
          } else {
            green(x0 - ww / 2 - 3, ww / 2);
            green(x0 + ww + 3, ww / 2);
            ctx.fillStyle = '#e8e4dc';
            ctx.fillRect(x0 - 4, top - 4, ww + 8, wh + 8);
            glass(ctx, x0, top, ww, wh);
            ctx.fillStyle = '#e8e4dc';
            ctx.fillRect(cx - 2, top, 4, wh);
            ctx.fillRect(x0, top + wh * 0.36, ww, 3);
          }
          ctx.fillStyle = '#cfc8bb';
          ctx.fillRect(x0 - 8, bottom, ww + 16, 7);
          ctx.fillStyle = 'rgba(80,70,60,0.25)';
          ctx.fillRect(x0 - 8, bottom + 7, ww + 16, 4);
        } else if (style === 'german') {
          // reveal shadow, white frame, glazing, roller shutter partly down on some windows
          ctx.fillStyle = 'rgba(90,85,78,0.35)';
          ctx.fillRect(x0 - 7, top - 7, ww + 14, wh + 14);
          ctx.fillStyle = '#f7f7f5';
          ctx.fillRect(x0 - 5, top - 5, ww + 10, wh + 10);
          glass(ctx, x0, top, ww, wh);
          const blind = (floor * 2 + col) % 3 === 2 ? 0.45 : (floor + col) % 4 === 0 ? 0.12 : 0;
          if (blind > 0) {
            ctx.fillStyle = '#b9b6b0';
            ctx.fillRect(x0, top, ww, wh * blind);
            ctx.fillStyle = 'rgba(70,70,70,0.35)';
            for (let y = top + 3; y < top + wh * blind; y += 4) ctx.fillRect(x0, y, ww, 1);
          }
          ctx.fillStyle = '#f7f7f5';
          ctx.fillRect(cx - 3, top, 6, wh);
          ctx.fillRect(x0, top + wh * 0.3, ww, 5);
          ctx.fillStyle = 'rgba(150,146,140,0.55)';
          ctx.fillRect(x0 - 5, top - 13, ww + 10, 8);
          ctx.fillStyle = '#9fa3a6';
          ctx.fillRect(x0 - 9, bottom + 4, ww + 18, 5);
          ctx.fillStyle = 'rgba(80,75,70,0.25)';
          ctx.fillRect(x0 - 9, bottom + 9, ww + 18, 3);
        } else {
          const wood = (sx: number, sw: number) => shutter(ctx, sx, top, sw, bottom, '#7a5232', 'rgba(40,22,10,0.5)');
          wood(x0 - ww / 2 - 3, ww / 2);
          wood(x0 + ww + 3, ww / 2);
          ctx.fillStyle = '#6b4a2f';
          ctx.fillRect(x0 - 5, top - 5, ww + 10, wh + 10);
          glass(ctx, x0, top, ww, wh);
          ctx.fillStyle = '#6b4a2f';
          ctx.fillRect(cx - 2, top, 4, wh);
          ctx.fillStyle = '#d8d0c2';
          ctx.fillRect(x0 - 8, bottom + 5, ww + 16, 6);
        }
      }
    }
    if (style === 'alpine') {
      // wooden balcony on the upper floor: slab, slatted parapet, handrail
      const slab = h - 3.1 * my;
      const rail = h - 4.15 * my;
      ctx.fillStyle = '#5a3d25';
      ctx.fillRect(0, slab - 4, w, 10);
      for (let x = 0; x < w; x += 9) {
        const g = 110 + Math.floor(rng() * 30);
        ctx.fillStyle = `rgb(${g},${Math.floor(g * 0.7)},${Math.floor(g * 0.45)})`;
        ctx.fillRect(x + 1, rail, 7, slab - rail);
      }
      ctx.fillStyle = '#4a3220';
      ctx.fillRect(0, rail - 6, w, 7);
      ctx.fillStyle = 'rgba(30,20,10,0.35)';
      ctx.fillRect(0, slab + 6, w, 8);
    }
  });
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/** Curved clay tiles ("coppi"), 2 m × 2 m per repeat, light so the vertex colour sets terracotta or stone grey. */
function coppi(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rng = createRng(11);
  const cols = 10;
  const rows = 5;
  const cw = w / cols;
  const rh = h / rows;
  for (let c = 0; c < cols; c++) {
    const g = ctx.createLinearGradient(c * cw, 0, (c + 1) * cw, 0);
    g.addColorStop(0, '#9b9089');
    g.addColorStop(0.35, '#f2e9e1');
    g.addColorStop(0.7, '#d9cfc6');
    g.addColorStop(1, '#8a8079');
    ctx.fillStyle = g;
    ctx.fillRect(c * cw, 0, cw, h);
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const shade = 0.85 + rng() * 0.3;
      ctx.fillStyle = `rgba(${shade > 1 ? 255 : 0},${shade > 1 ? 255 : 0},${shade > 1 ? 255 : 0},${Math.abs(shade - 1) * 0.6})`;
      ctx.fillRect(c * cw, r * rh, cw, rh);
    }
    ctx.fillStyle = 'rgba(40,30,25,0.45)';
    ctx.fillRect(0, r * rh, w, 3);
  }
}

/** Interlocking tiles ("Frankfurter Pfanne"): 8 courses × 8 tiles with two waves each per 2 m. */
function pfanne(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rng = createRng(12);
  const rows = 8;
  const cols = 8;
  const rh = h / rows;
  const cw = w / cols;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cw + (r % 2) * cw * 0.5;
      const k = 0.9 + rng() * 0.16;
      for (const ox of [0, -w]) {
        for (let wave = 0; wave < 2; wave++) {
          const g = ctx.createLinearGradient(x + ox + (wave * cw) / 2, 0, x + ox + ((wave + 1) * cw) / 2, 0);
          g.addColorStop(0, `rgb(${(150 * k) | 0},${(146 * k) | 0},${(142 * k) | 0})`);
          g.addColorStop(0.4, `rgb(${(238 * k) | 0},${(234 * k) | 0},${(230 * k) | 0})`);
          g.addColorStop(1, `rgb(${(176 * k) | 0},${(172 * k) | 0},${(168 * k) | 0})`);
          ctx.fillStyle = g;
          ctx.fillRect(x + ox + (wave * cw) / 2, r * rh, cw / 2, rh);
        }
      }
    }
    // the course above overlaps: shadow line at its lower edge
    const s = ctx.createLinearGradient(0, r * rh, 0, r * rh + rh * 0.3);
    s.addColorStop(0, 'rgba(25,22,20,0.6)');
    s.addColorStop(1, 'rgba(25,22,20,0)');
    ctx.fillStyle = s;
    ctx.fillRect(0, r * rh, w, rh * 0.3);
  }
}

/** Slate or stone slabs ("lauzes") in staggered courses of irregular width, 10 courses per 2 m. */
function slate(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const rng = createRng(13);
  ctx.fillStyle = '#4a4846';
  ctx.fillRect(0, 0, w, h);
  const rows = 10;
  const rh = h / rows;
  for (let r = 0; r < rows; r++) {
    let x = -rng() * 30;
    while (x < w) {
      const sw = 18 + rng() * 22;
      const g = 175 + Math.floor(rng() * 60);
      for (const ox of [0, -w]) {
        ctx.fillStyle = `rgb(${g},${g - 2},${g - 5})`;
        ctx.beginPath();
        ctx.roundRect(x + ox + 1, r * rh + 1, sw - 2, rh + 1, [0, 0, 5, 5]);
        ctx.fill();
      }
      x += sw;
    }
    ctx.fillStyle = 'rgba(20,20,22,0.5)';
    ctx.fillRect(0, r * rh, w, 2);
  }
  speckle(ctx, rng, 0, w, h, 1800, 150, 60, 1);
}

/** Roof covering per architecture, 2 m × 2 m per repeat, light so the vertex colour sets the roof colour. */
export function roofTexture(scene: Scene, style: Architecture = 'italian'): DynamicTexture {
  const draw = style === 'italian' ? coppi : style === 'german' ? pfanne : slate;
  const tex = canvasTexture(scene, `roof-tex-${style}`, 256, 256, (ctx, w, h) => draw(ctx, w, h));
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

export const TREE_TYPES = 4;
export const TREE = { broadleaf: 0, conifer: 1, cypress: 2, garden: 3 } as const;

/**
 * Tree sprite atlas (4 cells side by side): chestnut/beech, spruce, Italian cypress, light garden tree.
 * Drawn from hundreds of shaded leaf blobs, lit from the upper left; alpha marks the silhouette.
 */
export function treeAtlas(scene: Scene): DynamicTexture {
  const tex = canvasTexture(
    scene,
    'tree-atlas',
    1024,
    256,
    (ctx) => {
      const rng = createRng(21);
      ctx.clearRect(0, 0, 1024, 256);
      const blob = (x: number, y: number, r: number, base: [number, number, number], light: number) => {
        const k = 0.7 + light * 0.55 + (rng() - 0.5) * 0.18;
        ctx.fillStyle = `rgb(${Math.min(255, base[0] * k) | 0},${Math.min(255, base[1] * k) | 0},${Math.min(255, base[2] * k) | 0})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      };
      const trunk = (cx: number, top: number, w: number, color: string) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(cx - w, 254);
        ctx.lineTo(cx - w * 0.45, top);
        ctx.lineTo(cx + w * 0.45, top);
        ctx.lineTo(cx + w, 254);
        ctx.fill();
      };
      const crown = (cx: number, cy: number, rx: number, ry: number, base: [number, number, number], count: number, rmin: number, rmax: number) => {
        for (let i = 0; i < count; i++) {
          const a = rng() * Math.PI * 2;
          const d = Math.sqrt(rng());
          const x = cx + Math.cos(a) * rx * d;
          const y = cy + Math.sin(a) * ry * d;
          const light = Math.max(0, Math.min(1, 0.5 - ((x - cx) / rx) * 0.35 - ((y - cy) / ry) * 0.45 + (1 - d) * 0.15));
          blob(x, y, rmin + rng() * (rmax - rmin), base, light);
        }
      };
      // 0: chestnut / beech
      trunk(128, 150, 9, '#4a3b2c');
      crown(128, 104, 104, 92, [70, 98, 44], 520, 7, 16);
      // 1: spruce — stacked drooping branch layers
      trunk(384, 200, 6, '#3d3026');
      for (let y = 14; y < 236; y += 3) {
        const t = (y - 10) / 226;
        const half = 6 + t * 92 * (0.85 + rng() * 0.3);
        for (let k = 0; k < 4; k++) {
          const x = 384 + (rng() * 2 - 1) * half;
          const light = Math.max(0, 0.55 - ((x - 384) / 100) * 0.4 - t * 0.25);
          blob(x, y + rng() * 4, 3 + rng() * 5, [34, 62, 38], light);
        }
      }
      // 2: Italian cypress — tall dark flame
      trunk(640, 230, 4, '#3a2e24');
      for (let i = 0; i < 700; i++) {
        const y = 8 + rng() * 236;
        const t = (y - 8) / 236;
        const half = 30 * Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.62) + 2;
        const x = 640 + (rng() * 2 - 1) * half;
        const light = Math.max(0, 0.5 - ((x - 640) / 32) * 0.45);
        blob(x, y, 3 + rng() * 4, [30, 54, 30], light);
      }
      // 3: light garden tree (lime, plane tree)
      trunk(896, 160, 8, '#6d6253');
      crown(896, 112, 96, 84, [92, 122, 58], 460, 7, 15);
    },
    true,
  );
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}
