import type { GraphicsQuality } from '../game/real/quality';
import { Store, loadJson, saveJson } from './store';

export interface Settings {
  riderName: string;
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
}

const KEY = 'velo.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  riderName: 'Fahrer',
  weightKg: 75,
  heightCm: 178,
  ftp: 200,
  trainerDifficulty: 0.5,
  useSimulator: false,
  preferCadenceSensor: true,
  serverUrl: '',
  rideOnline: true,
  graphicsQuality: 'auto',
};

export const settingsStore = new Store<Settings>(loadJson(KEY, DEFAULT_SETTINGS));
settingsStore.subscribe(() => saveJson(KEY, settingsStore.get()));

export function updateSettings(patch: Partial<Settings>): void {
  settingsStore.set((s) => ({ ...s, ...patch }));
}
