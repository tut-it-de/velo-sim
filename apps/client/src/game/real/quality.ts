import type { AbstractEngine, Engine } from '@babylonjs/core';

export type GraphicsQuality = 'auto' | 'ultra' | 'hoch' | 'mittel' | 'niedrig';
export type QualityLevel = Exclude<GraphicsQuality, 'auto'>;

export const GRAPHICS_QUALITY_OPTIONS: Array<{ id: GraphicsQuality; label: string; hint: string }> = [
  { id: 'auto', label: 'Automatisch', hint: 'erkennt das Gerät und passt die Auflösung an' },
  { id: 'ultra', label: 'Ultra', hint: 'Schatten von Bäumen und Häusern, Umgebungsverdeckung – nur starke Grafikkarten' },
  { id: 'hoch', label: 'Hoch', hint: 'Spiegelungen, dichter Wald, Schatten' },
  { id: 'mittel', label: 'Mittel', hint: 'für Laptops und iPad' },
  { id: 'niedrig', label: 'Niedrig', hint: 'für schwache Grafik' },
];

export interface QualityProfile {
  level: QualityLevel;
  /** Highest device-pixel ratio rendered. */
  dprCap: number;
  /** Near-terrain LOD switch distances (half, quarter resolution). */
  terrainLod: [number, number];
  /** Lake reflection render-target size relative to the screen, 0 = no reflection. */
  mirror: number;
  /** Trees are planted this far from the road. */
  treeRadius: number;
  /** Tree chunks further away than this are not drawn. */
  treeDistance: number;
  /** Building chunks further away than this are not drawn. */
  buildingDistance: number;
  /** Shadow-map size for riders, 0 = off. */
  shadowMap: number;
  /** Shadow cascades for trees, walls and houses, 0 = rider shadow only. */
  cascades: number;
  /** Reach of the shadows in metres. */
  shadowDistance: number;
  /** Ambient occlusion: darkens corners and crevices (contact shadows). */
  ssao: boolean;
  /** Fine ground detail and forest canopy relief in the terrain shader. */
  detail: boolean;
  /** Colour grading and vignette on top of the tone mapping. */
  grading: boolean;
  /** HDR post-process pipeline (MSAA, bloom, tone mapping in one pass); otherwise tone mapping runs in the materials. */
  postProcess: boolean;
  /** Adapt the render resolution to keep the frame rate up. */
  dynamicResolution: boolean;
}

const PROFILES: Record<QualityLevel, Omit<QualityProfile, 'dynamicResolution'>> = {
  ultra: { level: 'ultra', dprCap: 2, terrainLod: [1400, 3400], mirror: 0.5, treeRadius: 380, treeDistance: 3200, buildingDistance: 4200, shadowMap: 1024, cascades: 3, shadowDistance: 160, ssao: true, detail: true, grading: true, postProcess: true },
  hoch: { level: 'hoch', dprCap: 1.75, terrainLod: [1400, 3400], mirror: 0.5, treeRadius: 320, treeDistance: 2600, buildingDistance: 4200, shadowMap: 1024, cascades: 2, shadowDistance: 90, ssao: false, detail: true, grading: true, postProcess: true },
  mittel: { level: 'mittel', dprCap: 1.3, terrainLod: [950, 2300], mirror: 0.3, treeRadius: 210, treeDistance: 1800, buildingDistance: 3000, shadowMap: 512, cascades: 0, shadowDistance: 0, ssao: false, detail: true, grading: true, postProcess: false },
  niedrig: { level: 'niedrig', dprCap: 1, terrainLod: [600, 1500], mirror: 0, treeRadius: 110, treeDistance: 1100, buildingDistance: 1900, shadowMap: 0, cascades: 0, shadowDistance: 0, ssao: false, detail: false, grading: false, postProcess: false },
};

function isAppleTablet(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Best guess from the GPU name and the device class. */
export function detectQuality(engine: Engine): QualityLevel {
  const renderer = (engine.getGlInfo().renderer || '').toLowerCase();
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  if (/swiftshader|llvmpipe|softpipe|software|microsoft basic/.test(renderer) || memory <= 2) return 'niedrig';
  if (isAppleTablet() || /android|mobile/i.test(navigator.userAgent)) return 'mittel';
  if (/nvidia|geforce|quadro|rtx|radeon (rx|pro)|apple m\d|apple gpu|arc/.test(renderer)) return 'hoch';
  if (/intel|mali|adreno|powervr/.test(renderer)) return memory >= 8 && /iris xe/.test(renderer) ? 'hoch' : 'mittel';
  return 'mittel';
}

export function resolveQuality(setting: GraphicsQuality, engine: Engine): QualityProfile {
  const level = setting === 'auto' ? detectQuality(engine) : setting;
  return { ...PROFILES[level], dynamicResolution: setting === 'auto' };
}

/**
 * Lowers the render resolution when frames take too long and raises it again when the display rate is
 * reached, between 55 % and 100 % of the profile's pixel ratio. A raise that has to be taken back soon
 * after doubles the wait before the next attempt, so the resolution does not keep pumping.
 */
export class DynamicResolution {
  private scale = 1;
  private acc = 0;
  private frames = 0;
  private sinceChange = 0;
  private raiseWait = 4;
  private lastWasRaise = false;

  constructor(
    private readonly engine: AbstractEngine,
    private readonly dpr: number,
  ) {
    this.apply();
  }

  update(dt: number): void {
    this.acc += dt;
    this.frames++;
    this.sinceChange += dt;
    if (this.acc < 1.5) return;
    const frameMs = (this.acc / this.frames) * 1000;
    this.acc = 0;
    this.frames = 0;
    if (frameMs > 21 && this.sinceChange > 2 && this.scale > 0.55) {
      if (this.lastWasRaise && this.sinceChange < 8) this.raiseWait = Math.min(90, this.raiseWait * 2);
      this.change(Math.max(0.55, this.scale - 0.1), false);
    } else if (frameMs < 18 && this.scale < 1 && this.sinceChange > this.raiseWait) {
      this.change(Math.min(1, this.scale + 0.05), true);
    }
  }

  private change(scale: number, raise: boolean): void {
    this.scale = scale;
    this.lastWasRaise = raise;
    this.sinceChange = 0;
    this.apply();
  }

  private apply(): void {
    this.engine.setHardwareScalingLevel(1 / Math.max(0.5, this.dpr * this.scale));
  }
}
