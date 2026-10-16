import { Vector3 } from '@babylonjs/core';

/** Direction the sunlight travels: afternoon sun from the south-west, about 38° above the horizon. */
export const SUN_DIR = new Vector3(0.55, -0.62, 0.55).normalize();
/** Unit vector pointing at the sun. */
export const TO_SUN = SUN_DIR.scale(-1);

export const SKY = {
  zenith: '#2a64b8',
  mid: '#6f9fd6',
  horizon: '#cddcea',
  /** Haze the fog fades distant mountains into. */
  fog: '#c4d3e2',
  sun: '#fff4dc',
};

/** Exponential-squared fog: mountains 10 km away stay visible, 30 km away they are gone. */
export const FOG_DENSITY = 0.000068;
