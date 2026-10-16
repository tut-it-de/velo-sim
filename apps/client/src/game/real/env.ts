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
  fog: '#b3c6dc',
  sun: '#fff4dc',
};

/** Exponential fog (aerial perspective): a quarter of the haze colour at 5 km, 70 % at 20 km. */
export const FOG_DENSITY = 0.00006;
