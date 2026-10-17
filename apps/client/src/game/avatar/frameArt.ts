/**
 * Frame decals: brand wordmarks and model names printed on the tubes. Every decorated tube gets a
 * row of one texture per bike: x runs along the tube (loft t, 0…1), y around it (the loft's arc,
 * 0 at the top of the row is the flank at angle 0, the middle of the row the opposite flank).
 * Lettering is laid out in metres on the tube's surface, so it keeps its proportions on thin
 * and deep tubes alike, and is turned so it reads along the tube from either side.
 */
export const FRAME_TEX_W = 2048;
export const FRAME_TEX_H = 1024;

/** Rows of the texture: [top, height] in pixels, with gaps so mipmaps don't bleed between tubes. */
export const FRAME_ROWS = {
  down: [0, 380],
  top: [388, 220],
  seat: [616, 220],
  fork: [844, 180],
} as const;
export type FrameRow = keyof typeof FRAME_ROWS;

// Open-licensed web fonts (SIL OFL) for the wordmarks, bundled so the lettering looks the same everywhere.
import '@fontsource/lexend/latin-800.css';
import '@fontsource/saira/latin-900-italic.css';
import '@fontsource/orbitron/latin-800.css';
import '@fontsource/playfair-display/latin-800-italic.css';
import '@fontsource/kanit/latin-800-italic.css';
import '@fontsource/archivo-black/latin-400.css';
import '@fontsource/montserrat/latin-800-italic.css';
import '@fontsource/audiowide/latin-400.css';
import '@fontsource/bebas-neue/latin-400.css';
import '@fontsource/barlow-condensed/latin-600.css';

/** A wordmark style; sizes are relative to the cap height. */
export interface MarkStyle {
  text: string;
  /** CSS font family (one of the bundled fonts above). */
  family: string;
  weight: number;
  italic?: boolean;
  /** Horizontal stretch (< 1 condensed, > 1 extended). */
  stretch?: number;
  /** Letter spacing as a share of the cap height. */
  spacing?: number;
  /** Slanted bar after the wordmark, as a share of the text width (0 for none). */
  bar?: number;
}

export interface DecalMark {
  style: MarkStyle;
  /** Centre along the tube (loft t). */
  at: number;
  /** Cap height in metres, and the longest the mark may run along the tube. */
  cap: number;
  maxLen: number;
  color: string;
}

/** One decorated tube: its texture row, size and how the lettering is turned on each flank. */
export interface DecalSlot {
  row: FrameRow;
  /** Length along the loft and perimeter around it, metres. */
  length: number;
  perimeter: number;
  /** Rotation of the lettering in the surface frame (along the tube, around it) on flank 0 and flank π. */
  turn: [number, number];
  marks: DecalMark[];
}

/** Texture coordinates (second uv channel) of a loft vertex for a tube on `row`. */
export function decalUv(row: FrameRow, t: number, arc: number): [number, number] {
  const [top, h] = FRAME_ROWS[row];
  const y = top + (1 - arc) * h;
  return [t, 1 - y / FRAME_TEX_H];
}

/** Wordmark of each brand, in the spirit of the real one it alludes to. */
export function brandMark(brand: string): MarkStyle {
  switch (brand) {
    case 'Servelo':
      // rounded geometric lower case
      return { text: 'servelo', family: 'Lexend', weight: 800, spacing: -0.03 };
    case 'Treck':
      return { text: 'TRECK', family: 'Saira', weight: 900, italic: true, stretch: 1.08, spacing: 0.02 };
    case 'Kanyon':
      // wide technical capitals
      return { text: 'KANYON', family: 'Orbitron', weight: 800, spacing: 0.1 };
    case 'Pinarolo':
      // Italian, elegant serif with a flourish bar
      return { text: 'Pinarolo', family: 'Playfair Display', weight: 800, italic: true, spacing: 0.02, bar: 0.22 };
    case 'Spezion':
      return { text: 'SPEZION', family: 'Kanit', weight: 800, italic: true, spacing: 0.02 };
    case 'Gigant':
      return { text: 'GIGANT', family: 'Archivo Black', weight: 400, stretch: 1.1, spacing: 0.04 };
    case 'Cannonvale':
      return { text: 'Cannonvale', family: 'Montserrat', weight: 800, italic: true, spacing: -0.02 };
    case 'Trivelo':
      return { text: 'TRIVELO', family: 'Archivo Black', weight: 400, spacing: 0.08, bar: 0.18 };
    case 'Nimbo':
      return { text: 'nimbo', family: 'Audiowide', weight: 400, spacing: 0.04 };
    case 'M6':
      return { text: 'M6', family: 'Audiowide', weight: 400, bar: 1.2 };
    default:
      return { text: brand.toUpperCase(), family: 'Bebas Neue', weight: 400, spacing: 0.28 };
  }
}

/** Model name in a narrow, spaced style. */
export function modelMark(model: string): MarkStyle {
  return { text: model.toUpperCase(), family: 'Barlow Condensed', weight: 600, spacing: 0.22 };
}

const fontSpec = (s: MarkStyle, px: number) => `${s.italic ? 'italic ' : ''}${s.weight} ${px}px "${s.family}", "Helvetica Neue", Arial, sans-serif`;

/** Resolves once the fonts of these decals are loaded (the canvas falls back silently until then). */
export function decalFontsReady(slots: DecalSlot[]): Promise<unknown> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  const specs = new Set(slots.flatMap((s) => s.marks.map((m) => fontSpec(m.style, 100))));
  return Promise.all([...specs].map((f) => document.fonts.load(f)));
}

type Ctx = CanvasRenderingContext2D;

/** Draws one mark centred at the origin, cap height 1 unit, baseline-centred; returns nothing. */
function drawMark(ctx: Ctx, m: DecalMark): void {
  const s = m.style;
  // size the font so capitals are `cap` high; work in a 100-unit font and scale down
  const unit = 100;
  const size = unit / 0.72;
  ctx.font = fontSpec(s, size);
  (ctx as Ctx & { letterSpacing?: string }).letterSpacing = `${(s.spacing ?? 0) * unit}px`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const stretch = s.stretch ?? 1;
  const w = ctx.measureText(s.text).width * stretch;
  const bar = (s.bar ?? 0) * w;
  const total = w + (bar ? bar + unit * 0.4 : 0);
  // fit the mark into its length
  const k = Math.min(m.cap / unit, m.maxLen / total);
  ctx.save();
  ctx.scale(k, k);
  ctx.fillStyle = m.color;
  ctx.save();
  ctx.translate(-total / 2 + w / 2, 0);
  ctx.scale(stretch, 1);
  ctx.fillText(s.text, 0, unit * 0.04);
  ctx.restore();
  if (bar) {
    // a slanted bar trailing the wordmark
    const x0 = -total / 2 + w + unit * 0.4;
    ctx.beginPath();
    ctx.moveTo(x0 + unit * 0.2, -unit * 0.18);
    ctx.lineTo(x0 + bar, -unit * 0.18);
    ctx.lineTo(x0 + bar - unit * 0.2, unit * 0.18);
    ctx.lineTo(x0, unit * 0.18);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Paints all decals of one bike into a transparent texture. */
export function paintFrameDecals(ctx: Ctx, slots: DecalSlot[]): void {
  ctx.clearRect(0, 0, FRAME_TEX_W, FRAME_TEX_H);
  for (const slot of slots) {
    const [top, h] = FRAME_ROWS[slot.row];
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, FRAME_TEX_W, h);
    ctx.clip();
    // metric frame on the surface: X along the tube, Y around it (increasing arc = up the row)
    ctx.translate(0, top + h);
    ctx.scale(FRAME_TEX_W / slot.length, -h / slot.perimeter);
    for (const m of slot.marks) {
      const cx = m.at * slot.length;
      // flank 0 sits on the row's edges (arc 0 and 1), flank π in the middle
      for (const [cy, turn] of [[0, slot.turn[0]], [slot.perimeter, slot.turn[0]], [slot.perimeter / 2, slot.turn[1]]] as const) {
        ctx.save();
        // glyphs are drawn y-down: map glyph (x, y) to X = x·R − y·U with R = (cos, sin), U = (−sin, cos)
        ctx.transform(Math.cos(turn), Math.sin(turn), Math.sin(turn), -Math.cos(turn), cx, cy);
        drawMark(ctx, m);
        ctx.restore();
      }
    }
    ctx.restore();
  }
  // transparent texels take the colour of the lettering, so filtering leaves no dark fringe
  const img = ctx.getImageData(0, 0, FRAME_TEX_W, FRAME_TEX_H);
  const d = img.data;
  for (const slot of slots) {
    const col = slot.marks[0]?.color;
    if (!col) continue;
    const n = parseInt(col.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const [top, h] = FRAME_ROWS[slot.row];
    for (let y = Math.max(0, top - 4); y < Math.min(FRAME_TEX_H, top + h + 4); y++) {
      for (let x = 0; x < FRAME_TEX_W; x++) {
        const o = (y * FRAME_TEX_W + x) * 4;
        if (d[o + 3] === 0) {
          d[o] = r;
          d[o + 1] = g;
          d[o + 2] = b;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
