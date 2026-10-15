/**
 * Cycling physics shared by client and (later) server.
 *
 *   m_eff · dv/dt = η·P / v − m·g·sinθ − Crr·m·g·cosθ − ½·ρ·CdA·(1 − draft)·(v + v_wind)²
 *
 * All units SI (kg, m, s, W) unless the name says otherwise.
 */

export const G = 9.80665;
export const AIR_DENSITY = 1.225;
/** Chain, bearings and trainer losses (~2.4 %). */
export const DRIVETRAIN_EFFICIENCY = 0.976;
/** Rider of 178 cm / 75 kg on the hoods with neutral equipment. */
export const REFERENCE_CDA = 0.3;
export const DEFAULT_CRR = 0.004;

export interface RiderSetup {
  riderMassKg: number;
  /** Bike without wheels. */
  bikeMassKg: number;
  wheelsMassKg: number;
  /** Total CdA in m² including equipment deltas (before drafting). */
  cda: number;
  crr: number;
}

export interface Environment {
  gradePercent: number;
  /** Positive = head wind. */
  headwindMps?: number;
  /** 0…1 fraction by which drafting reduces aerodynamic drag. */
  draftReduction?: number;
  airDensity?: number;
}

export interface RiderState {
  speedMps: number;
  distanceM: number;
}

export function bodySurfaceArea(heightCm: number, weightKg: number): number {
  // Du Bois formula
  return 0.007184 * weightKg ** 0.425 * heightCm ** 0.725;
}

const REFERENCE_BSA = bodySurfaceArea(178, 75);

/**
 * Rider CdA scaled by body size. The body is roughly three quarters of the
 * total drag, the bike the rest.
 */
export function baseCdA(heightCm: number, weightKg: number): number {
  const ratio = bodySurfaceArea(heightCm, weightKg) / REFERENCE_BSA;
  return REFERENCE_CDA * (0.25 + 0.75 * ratio);
}

export function totalMass(s: RiderSetup): number {
  return s.riderMassKg + s.bikeMassKg + s.wheelsMassKg;
}

/** Rotating wheels add inertia: heavy (rim-heavy) wheels accelerate slower. */
export function effectiveMass(s: RiderSetup): number {
  return totalMass(s) + 0.7 * s.wheelsMassKg;
}

/** Wind resistance coefficient for the trainer's SIM mode (FTMS "Cw", kg/m). */
export function windResistanceCoefficient(cda: number, airDensity = AIR_DENSITY): number {
  return 0.5 * airDensity * cda;
}

export interface Forces {
  gravity: number;
  rolling: number;
  aero: number;
  total: number;
}

export function resistanceForces(speedMps: number, setup: RiderSetup, env: Environment): Forces {
  const m = totalMass(setup);
  const theta = Math.atan(env.gradePercent / 100);
  const gravity = m * G * Math.sin(theta);
  const rolling = speedMps > 0.01 ? setup.crr * m * G * Math.cos(theta) : 0;
  const air = speedMps + (env.headwindMps ?? 0);
  const rho = env.airDensity ?? AIR_DENSITY;
  const aero = 0.5 * rho * setup.cda * (1 - (env.draftReduction ?? 0)) * air * Math.abs(air);
  return { gravity, rolling, aero, total: gravity + rolling + aero };
}

/** Pedal power needed to hold `speedMps` steadily. */
export function powerForSpeed(speedMps: number, setup: RiderSetup, env: Environment): number {
  return Math.max(0, (resistanceForces(speedMps, setup, env).total * speedMps) / DRIVETRAIN_EFFICIENCY);
}

const MIN_DRIVE_SPEED = 1.0;
const MAX_DRIVE_FORCE = 450;
const MAX_SUBSTEP = 0.02;

/** Integrates the rider's motion for `dt` seconds at constant pedal power. */
export function step(state: RiderState, powerW: number, setup: RiderSetup, env: Environment, dt: number): RiderState {
  const mEff = effectiveMass(setup);
  const n = Math.max(1, Math.ceil(dt / MAX_SUBSTEP));
  const h = dt / n;
  let v = state.speedMps;
  let d = state.distanceM;
  const p = Math.max(0, powerW) * DRIVETRAIN_EFFICIENCY;
  for (let i = 0; i < n; i++) {
    const drive = Math.min(MAX_DRIVE_FORCE, p / Math.max(v, MIN_DRIVE_SPEED));
    const net = drive - resistanceForces(v, setup, env).total;
    if (v <= 0 && net <= 0) {
      v = 0; // no rolling backwards
      continue;
    }
    v = Math.max(0, v + (net / mEff) * h);
    d += v * h;
  }
  return { speedMps: v, distanceM: d };
}

/** Speed at which pedal power and resistance balance (time comparison, bots). */
export function steadySpeed(powerW: number, setup: RiderSetup, env: Environment): number {
  const p = Math.max(0, powerW) * DRIVETRAIN_EFFICIENCY;
  // g(v) = drive − resistance; strictly decreasing for v > 0.
  const g = (v: number) => p / v - resistanceForces(v, setup, env).total;
  let lo = 0.01;
  let hi = 40;
  if (g(lo) <= 0) return 0;
  if (g(hi) > 0) return hi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (g(mid) > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Drag reduction from riding behind someone. `gapM` is the distance from my
 * front wheel to the rear wheel of the rider in front.
 */
export const MAX_DRAFT_REDUCTION = 0.32;

export function draftReduction(gapM: number): number {
  if (gapM < 0 || gapM > 15) return 0;
  if (gapM <= 1.5) return MAX_DRAFT_REDUCTION;
  return MAX_DRAFT_REDUCTION * Math.exp(-(gapM - 1.5) / 3.5);
}

export const msToKmh = (v: number) => v * 3.6;
export const kmhToMs = (v: number) => v / 3.6;
