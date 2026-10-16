import { Vector3 } from '@babylonjs/core';

/** Direction the sunlight travels: late-afternoon sun from the south-west, about 22° above the horizon. */
export const SUN_DIR = new Vector3(0.655, -0.375, 0.655).normalize();
/** Unit vector pointing at the sun. */
export const TO_SUN = SUN_DIR.scale(-1);

export const SKY = {
  zenith: '#2c62b0',
  mid: '#7aa6d8',
  horizon: '#e6dccb',
  /** Haze the fog fades distant mountains into. */
  fog: '#c9c6bd',
  sun: '#ffe2b0',
};

/** Exponential fog (aerial perspective): a quarter of the haze colour at 5 km, 70 % at 20 km. */
export const FOG_DENSITY = 0.00006;
