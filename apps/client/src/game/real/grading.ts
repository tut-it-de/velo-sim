import {
  Color3,
  ColorCurves,
  DefaultRenderingPipeline,
  ImageProcessingConfiguration,
  type Camera,
  type Effect,
  type Scene,
} from '@babylonjs/core';
import type { QualityProfile } from './quality';

type ImageDefines = Parameters<ImageProcessingConfiguration['prepareDefines']>[0];

/**
 * Film-like image: an ACES tone curve with a filmic shoulder (the light is warm and no longer flat,
 * so the shadows are no longer crushed and the sky and sun glints keep their detail), a touch of
 * exposure and contrast, warm highlights and cool shadows, a mild vignette and dithering against
 * banding in the sky. On 'hoch' and 'ultra' an HDR pipeline does this in one post-process pass together
 * with MSAA and a faint bloom on sun glints and bright clouds ('ultra' adds a light sharpen); otherwise
 * the same image processing runs inside the materials (no extra passes, the canvas keeps its MSAA).
 * Must run before the materials are compiled and frozen.
 */
export function setupImagePipeline(scene: Scene, camera: Camera, quality: QualityProfile): DefaultRenderingPipeline | null {
  let pipeline: DefaultRenderingPipeline | null = null;
  if (quality.postProcess) {
    pipeline = new DefaultRenderingPipeline('look', true, scene, [camera]);
    pipeline.samples = 4;
    pipeline.fxaaEnabled = false;
    pipeline.bloomEnabled = true;
    pipeline.bloomThreshold = 0.85;
    pipeline.bloomWeight = 0.22;
    pipeline.bloomKernel = 48;
    pipeline.bloomScale = 0.5;
    pipeline.imageProcessingEnabled = true;
    if (quality.level === 'ultra') {
      pipeline.chromaticAberrationEnabled = false;
      pipeline.sharpenEnabled = true;
      pipeline.sharpen.edgeAmount = 0.25;
    }
  }
  const ip = scene.imageProcessingConfiguration;
  ip.isEnabled = true;
  ip.toneMappingEnabled = true;
  ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  ip.exposure = 1.7;
  ip.contrast = 1.06;
  if (quality.grading) {
    const curves = new ColorCurves();
    curves.globalSaturation = 6;
    curves.highlightsHue = 40;
    curves.highlightsDensity = 22;
    curves.shadowsHue = 210;
    curves.shadowsDensity = 18;
    curves.shadowsSaturation = 10;
    ip.colorCurves = curves;
    ip.colorCurvesEnabled = true;
    ip.vignetteEnabled = true;
    ip.vignetteWeight = 0.9;
    ip.vignetteStretch = 0.6;
    ip.vignetteCameraFov = camera.fov;
    ip.vignetteColor = new Color3(0.05, 0.06, 0.09).toColor4(0);
  }
  // the HDR image is quantised to 8 bits only at the end: dither against banding in the sky
  ip.ditheringEnabled = quality.postProcess;
  ip.ditheringIntensity = 1 / 255;
  return pipeline;
}

/** What a ShaderMaterial needs to apply the scene's image processing exactly like the built-in materials. */
export interface ShaderImageProcessing {
  defines: string[];
  uniforms: string[];
  bind(effect: Effect): void;
}

/**
 * Defines and uniforms for `#include<imageProcessingFunctions>` in a custom shader, fixed at creation
 * (the configuration does not change after the world is built). With the HDR pipeline the shader just
 * outputs linear colour (IMAGEPROCESSINGPOSTPROCESS).
 */
export function shaderImageProcessing(scene: Scene): ShaderImageProcessing {
  const ip = scene.imageProcessingConfiguration;
  const d: ImageDefines = {
    IMAGEPROCESSING: false,
    WHITEBALANCE: false,
    VIGNETTE: false,
    VIGNETTEBLENDMODEMULTIPLY: false,
    VIGNETTEBLENDMODEOPAQUE: false,
    TONEMAPPING: 0,
    CONTRAST: false,
    EXPOSURE: false,
    COLORCURVES: false,
    COLORGRADING: false,
    COLORGRADING3D: false,
    SAMPLER3DGREENDEPTH: false,
    SAMPLER3DBGRMAP: false,
    DITHER: false,
    IMAGEPROCESSINGPOSTPROCESS: false,
    SKIPFINALCOLORCLAMP: false,
  };
  ip.prepareDefines(d);
  const defines = Object.entries(d).flatMap(([k, v]) => (typeof v === 'number' ? [`#define ${k} ${v}`] : v ? [`#define ${k}`] : []));
  const uniforms: string[] = [];
  ImageProcessingConfiguration.PrepareUniforms(uniforms, d);
  return {
    defines,
    uniforms,
    bind: (effect) => {
      if (d.IMAGEPROCESSING && !d.IMAGEPROCESSINGPOSTPROCESS) ip.bind(effect);
    },
  };
}
