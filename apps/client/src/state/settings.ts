import type { GraphicsQuality } from '../game/real/quality';
import { builtInServer } from '../net/serverUrl';
import { Store, loadJson, saveJson } from './store';

export interface Settings {
  riderName: string;
  /** ISO 3166-1 alpha-2 country code, shown as a flag next to the name. */
  country: string;
  weightKg: number;
  heightCm: number;
  /** Functional Threshold Power in watts — workouts are defined relative to it. */
  ftp: number;
  /** 0…1 — how much of the virtual grade the trainer simulates (Zwift default 50 %). */
  trainerDifficulty: number;
  /** Use the built-in simulated trainer instead of Bluetooth. */
  useSimulator: boolean;
  /** Prefer a dedicated cadence sensor over the trainer's estimated cadence. */
  preferCadenceSensor: boolean;
  /** Game server, e.g. https://velo.example.de — empty = offline only. */
  serverUrl: string;
  /** Join the multiplayer room when starting a ride (if a server is configured). */
  rideOnline: boolean;
  /** Graphics profile for the real-world routes. */
  graphicsQuality: GraphicsQuality;
  /** Admin tools in the ride (teleport along the route). Rides with a teleport earn nothing. */
  adminMode: boolean;
  /** Last trainer and heart rate strap, found again automatically in the iPad app. */
  knownDevices: { trainer?: string; hrm?: string; shifter?: string };
  /** Virtual shifting with the mouse while riding: left click heavier, right click lighter. */
  shiftMouse: boolean;
  /** Virtual shifting with the keys − and +. */
  shiftKeys: boolean;
}

const KEY = 'velo.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  riderName: 'Fahrer',
  country: 'DE',
  weightKg: 75,
  heightCm: 178,
  ftp: 200,
  trainerDifficulty: 0.5,
  useSimulator: false,
  preferCadenceSensor: true,
  serverUrl: '',
  rideOnline: true,
  graphicsQuality: 'auto',
  adminMode: false,
  knownDevices: {},
  shiftMouse: false,
  shiftKeys: true,
};

/**
 * Builds with a public server (the iPad app → https://velo.tut-it.de) drop an older LAN address like
 * http://192.168.x.y:8080 from the time the app talked to a Mac at home, so they use the public server.
 */
function withoutStaleLanServer(s: Settings): Settings {
  const lan = /^http:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost|127\.)/;
  return builtInServer.startsWith('https://') && lan.test(s.serverUrl) ? { ...s, serverUrl: '' } : s;
}

export const settingsStore = new Store<Settings>(withoutStaleLanServer(loadJson(KEY, DEFAULT_SETTINGS)));
settingsStore.subscribe(() => saveJson(KEY, settingsStore.get()));

export function updateSettings(patch: Partial<Settings>): void {
  settingsStore.set((s) => ({ ...s, ...patch }));
}
