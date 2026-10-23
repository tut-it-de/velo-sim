import type { GraphicsQuality } from '../game/real/quality';
import { builtInServer } from '../net/serverUrl';
import { DEFAULT_HUD_LAYOUT, sanitizeLayout, type HudLayout } from '../ride/hudFields';
import { Store, loadJson, saveJson } from './store';

export interface Settings {
  riderName: string;
  /** ISO 3166-1 alpha-2 country code, shown as a flag next to the name. */
  country: string;
  weightKg: number;
  heightCm: number;
  /** Functional Threshold Power in watts — workouts are defined relative to it. 0 = not known yet (see ftp/ftpStore). */
  ftp: number;
  /** 0…1 — how much of the virtual grade the trainer simulates (Zwift default 50 %). */
  trainerDifficulty: number;
  /** Use the built-in simulated trainer instead of Bluetooth. */
  useSimulator: boolean;
  /** Prefer a dedicated cadence sensor over the trainer's estimated cadence. */
  preferCadenceSensor: boolean;
  /** Pause the ride automatically when the pedals stop. */
  autoPause: boolean;
  /** Game server, e.g. https://velo.example.de — empty = offline only. */
  serverUrl: string;
  /** Join the multiplayer room when starting a ride (if a server is configured). */
  rideOnline: boolean;
  /** Graphics profile for the real-world routes. */
  graphicsQuality: GraphicsQuality;
  /** Admin tools in the ride (teleport along the route). Rides with a teleport earn nothing. */
  adminMode: boolean;
  /** Rides without an account: rides, garage and Taler stay on this device. */
  guest: boolean;
  /** Last trainer and heart rate strap, found again automatically in the iPad app. */
  knownDevices: { trainer?: string; hrm?: string; cadence?: string; shifter?: string };
  /** Virtual shifting with the mouse while riding: left click heavier, right click lighter. */
  shiftMouse: boolean;
  /** Virtual shifting with the keys − and +. */
  shiftKeys: boolean;
  /** Data fields of the bottom HUD bar and their order, for free rides and workouts. */
  hudFields: HudLayout;
}

const KEY = 'velo.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  riderName: 'Fahrer',
  country: 'DE',
  weightKg: 75,
  heightCm: 178,
  ftp: 0,
  trainerDifficulty: 0.5,
  useSimulator: false,
  preferCadenceSensor: true,
  autoPause: true,
  serverUrl: '',
  rideOnline: true,
  graphicsQuality: 'auto',
  adminMode: false,
  guest: false,
  knownDevices: {},
  shiftMouse: false,
  shiftKeys: true,
  hudFields: DEFAULT_HUD_LAYOUT,
};

/**
 * Brings stored settings up to date: older versions have no `hudFields` (→ today's layout), lists from
 * other versions may hold unknown or duplicate fields or too many of them.
 */
export function migrateSettings(stored: Settings): Settings {
  return { ...stored, hudFields: stored.hudFields ? sanitizeLayout(stored.hudFields) : DEFAULT_HUD_LAYOUT };
}

/**
 * Builds with a public server (the iPad app → https://velo.tut-it.de) drop an older LAN address like
 * http://192.168.x.y:8080 from the time the app talked to a Mac at home, so they use the public server.
 */
function withoutStaleLanServer(s: Settings): Settings {
  const lan = /^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost|127\.)/;
  return builtInServer.startsWith('https://') && lan.test(s.serverUrl) ? { ...s, serverUrl: '' } : s;
}

export const settingsStore = new Store<Settings>(withoutStaleLanServer(migrateSettings(loadJson(KEY, DEFAULT_SETTINGS))));
settingsStore.subscribe(() => saveJson(KEY, settingsStore.get()));

export function updateSettings(patch: Partial<Settings>): void {
  settingsStore.set((s) => ({ ...s, ...patch }));
}
