import type { SimulationParameters } from '../ftms/controlPoint';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface DeviceEvents<Data> {
  data: Data;
  connection: ConnectionState;
  [key: string]: unknown;
}

export interface TrainerData {
  /** ms since epoch when this snapshot was produced */
  timestamp: number;
  power?: number;
  cadence?: number;
  speedKmh?: number;
  heartRate?: number;
}

export type TrainerProtocol = 'ftms' | 'wahoo' | 'power-only';

export interface TrainerCapabilities {
  /** Trainer can hold a target power (ERG mode). */
  erg: boolean;
  /** Trainer can simulate grade (SIM mode). */
  sim: boolean;
  power: boolean;
  cadence: boolean;
  speed: boolean;
}

export interface TrainerSimParams extends SimulationParameters {
  /** Rider + bike weight, only used by the Wahoo legacy protocol. */
  totalWeightKg?: number;
}

export interface DeviceInformation {
  manufacturer?: string;
  model?: string;
  serial?: string;
  firmware?: string;
  hardware?: string;
}

export interface HeartRateData {
  timestamp: number;
  heartRate: number;
  rrIntervalsMs: number[];
}

export interface CadenceData {
  timestamp: number;
  cadence: number;
}
