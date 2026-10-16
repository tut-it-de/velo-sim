import { DynamicTexture, Texture, type Scene } from '@babylonjs/core';
import { createRng } from '../noise';

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

/**
 * Asphalt across the full road width (u: 0–0.06 shoulder, 0.06–0.94 asphalt, 0.94–1 shoulder) over
 * 24 m. Open road: white edge lines and the Italian 4.5 m / 7.5 m centre dashes. Town: kerbstones,
 * patched asphalt, no centre line.
 */
export function roadTexture(scene: Scene, town: boolean): DynamicTexture {
  return canvasTexture(scene, town ? 'road-town-tex' : 'road-tex', 512, 1024, (ctx, w, h) => {
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
    ctx.fillStyle = town ? '#4a4b4d' : '#434548';
    ctx.fillRect(a0, 0, a1 - a0, h);
    speckle(ctx, rng, a0, a1, h, 26000, town ? 76 : 70, 34);
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
      const dash = (4.5 / 24) * h;
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

/**
 * Plastered facade, two window axes × two floors (7.2 m × 6.2 m): windows with green shutters,
 * stone sills and a string course. Near-white so the per-building vertex colour sets the paint.
 */
export function facadeTexture(scene: Scene): DynamicTexture {
  const tex = canvasTexture(scene, 'facade-tex', 512, 512, (ctx, w, h) => {
    const rng = createRng(5);
    const mx = w / 7.2;
    const my = h / 6.2;
    ctx.fillStyle = '#f1ece3';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) {
      const g = 220 + Math.floor(rng() * 30);
      ctx.fillStyle = `rgba(${g},${g - 4},${g - 10},0.5)`;
      ctx.fillRect(rng() * w, rng() * h, 2, 2);
    }
    for (let i = 0; i < 14; i++) {
      const x = rng() * w;
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(120,110,95,0)');
      g.addColorStop(1, 'rgba(120,110,95,0.12)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 6 + rng() * 20, h);
    }
    // string course at each floor line (canvas y grows downwards: floor lines at 0, 3.1 m, 6.2 m)
    ctx.fillStyle = 'rgba(205,198,186,1)';
    for (const fy of [0, 3.1]) ctx.fillRect(0, h - (fy + 0.02) * my - 5, w, 6);
    for (let floor = 0; floor < 2; floor++) {
      for (let col = 0; col < 2; col++) {
        const cx = (col + 0.5) * 3.6 * mx;
        const bottom = h - (floor * 3.1 + 0.95) * my;
        const top = h - (floor * 3.1 + 2.35) * my;
        const ww = 1.0 * mx;
        const x0 = cx - ww / 2;
        const closed = (floor + col * 3) % 4 === 1;
        // shutters
        const shutter = (sx: number, sw: number) => {
          ctx.fillStyle = '#4d6a48';
          ctx.fillRect(sx, top, sw, bottom - top);
          ctx.fillStyle = 'rgba(20,35,20,0.45)';
          for (let y = top + 4; y < bottom; y += 6) ctx.fillRect(sx + 2, y, sw - 4, 2);
        };
        if (closed) {
          shutter(x0, ww / 2 - 1);
          shutter(x0 + ww / 2 + 1, ww / 2 - 1);
        } else {
          shutter(x0 - ww / 2 - 3, ww / 2);
          shutter(x0 + ww + 3, ww / 2);
          ctx.fillStyle = '#e8e4dc';
          ctx.fillRect(x0 - 4, top - 4, ww + 8, bottom - top + 8);
          const g = ctx.createLinearGradient(x0, top, x0 + ww, bottom);
          g.addColorStop(0, '#59697a');
          g.addColorStop(0.45, '#2c3540');
          g.addColorStop(1, '#1c2229');
          ctx.fillStyle = g;
          ctx.fillRect(x0, top, ww, bottom - top);
          ctx.fillStyle = '#e8e4dc';
          ctx.fillRect(cx - 2, top, 4, bottom - top);
          ctx.fillRect(x0, top + (bottom - top) * 0.36, ww, 3);
        }
        ctx.fillStyle = '#cfc8bb';
        ctx.fillRect(x0 - 8, bottom, ww + 16, 7);
        ctx.fillStyle = 'rgba(80,70,60,0.25)';
        ctx.fillRect(x0 - 8, bottom + 7, ww + 16, 4);
      }
    }
  });
  tex.wrapU = Texture.WRAP_ADDRESSMODE;
  tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/** Curved clay tiles ("coppi"), 2 m × 2 m per repeat, light so the vertex colour sets terracotta or stone grey. */
export function roofTexture(scene: Scene): DynamicTexture {
  const tex = canvasTexture(scene, 'roof-tex', 256, 256, (ctx, w, h) => {
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
  });
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
