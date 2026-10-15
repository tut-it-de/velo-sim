import {
  SimulatedTransport,
  dumpGattTable,
  errorMessage,
  requestCadenceSensor,
  requestHeartRateMonitor,
  requestTrainer,
  type BleTransport,
  type CadenceSensor,
  type ConnectionState,
  type HeartRateMonitor,
  type SmartTrainer,
  type TrainerSimParams,
} from '@velo/ble';
import { log } from '../state/log';
import { settingsStore } from '../state/settings';
import { Store } from '../state/store';
import { getBluetoothTransport } from './platform';

export type DeviceSlot = 'trainer' | 'hrm' | 'cadence';

export interface SlotState {
  state: ConnectionState;
  name?: string;
  error?: string;
  simulated?: boolean;
}

export interface LiveMetrics {
  timestamp: number;
  /** Instantaneous power in W (0 when the trainer stopped sending). */
  power: number;
  /** 3-second rolling average — what the HUD shows. */
  power3s: number;
  cadence: number;
  heartRate?: number;
  trainerSpeedKmh?: number;
  /** True when no trainer data arrived for STALE_MS. */
  stale: boolean;
  cadenceSource: 'trainer' | 'sensor' | null;
  heartRateSource: 'hrm' | 'trainer' | null;
}

const STALE_MS = 3000;

const EMPTY_METRICS: LiveMetrics = {
  timestamp: 0,
  power: 0,
  power3s: 0,
  cadence: 0,
  stale: true,
  cadenceSource: null,
  heartRateSource: null,
};

const disconnected: SlotState = { state: 'disconnected' };

/**
 * App-wide owner of all sensors. Merges their data into one LiveMetrics stream
 * (dedicated sensors win over trainer estimates) and exposes trainer control.
 */
class DeviceManager {
  readonly slots = new Store<Record<DeviceSlot, SlotState>>({ trainer: disconnected, hrm: disconnected, cadence: disconnected });
  readonly metrics = new Store<LiveMetrics>(EMPTY_METRICS);
  readonly simTransport = new SimulatedTransport();

  trainer?: SmartTrainer;
  hrm?: HeartRateMonitor;
  cadenceSensor?: CadenceSensor;

  private powerWindow: Array<{ t: number; p: number }> = [];
  private lastTrainerData = 0;
  private sensorCadence?: { value: number; t: number };
  private hrmValue?: { value: number; t: number };

  constructor() {
    setInterval(() => this.checkStale(), 1000);
  }

  private transport(): BleTransport {
    return settingsStore.get().useSimulator ? this.simTransport : getBluetoothTransport();
  }

  private patchSlot(slot: DeviceSlot, patch: Partial<SlotState>): void {
    this.slots.set((s) => ({ ...s, [slot]: { ...s[slot], ...patch } }));
  }

  async connect(slot: DeviceSlot): Promise<void> {
    const transport = this.transport();
    const simulated = transport.id === 'simulated';
    this.patchSlot(slot, { state: 'connecting', error: undefined, simulated });
    try {
      if (slot === 'trainer') {
        await this.trainer?.disconnect();
        const t = await requestTrainer(transport, { log });
        this.trainer = t;
        t.on('data', (d) => {
          this.lastTrainerData = Date.now();
          this.pushPower(d.power ?? 0);
          this.recompute({ trainerCadence: d.cadence, trainerHr: d.heartRate, trainerSpeed: d.speedKmh });
        });
        t.on('connection', (state) => this.patchSlot('trainer', { state }));
        this.patchSlot('trainer', { state: 'connected', name: t.name });
        log('info', t.describe().replace(/\n/g, ' · '));
      } else if (slot === 'hrm') {
        await this.hrm?.disconnect();
        const h = await requestHeartRateMonitor(transport, { log });
        this.hrm = h;
        h.on('data', (d) => {
          this.hrmValue = { value: d.heartRate, t: Date.now() };
          this.recompute({});
        });
        h.on('connection', (state) => this.patchSlot('hrm', { state }));
        this.patchSlot('hrm', { state: 'connected', name: h.name });
      } else {
        await this.cadenceSensor?.disconnect();
        const c = await requestCadenceSensor(transport, { log });
        this.cadenceSensor = c;
        c.on('data', (d) => {
          this.sensorCadence = { value: d.cadence, t: Date.now() };
          this.recompute({});
        });
        c.on('connection', (state) => this.patchSlot('cadence', { state }));
        this.patchSlot('cadence', { state: 'connected', name: c.name });
      }
    } catch (err) {
      const msg = errorMessage(err);
      const cancelled = /cancel|abgebrochen|User cancelled|chooser/i.test(msg);
      this.patchSlot(slot, { state: 'disconnected', error: cancelled ? undefined : msg });
      if (!cancelled) log('error', `Verbinden fehlgeschlagen: ${msg}`);
    }
  }

  async disconnect(slot: DeviceSlot): Promise<void> {
    const device = slot === 'trainer' ? this.trainer : slot === 'hrm' ? this.hrm : this.cadenceSensor;
    await device?.disconnect();
    if (slot === 'trainer') this.trainer = undefined;
    if (slot === 'hrm') {
      this.hrm = undefined;
      this.hrmValue = undefined;
    }
    if (slot === 'cadence') {
      this.cadenceSensor = undefined;
      this.sensorCadence = undefined;
    }
    this.patchSlot(slot, { state: 'disconnected', name: undefined });
    this.recompute({});
  }

  /** Full GATT table of the trainer — paste this into an issue when something does not work. */
  async trainerGattTable(): Promise<string> {
    if (!this.trainer) return 'Kein Trainer verbunden';
    return dumpGattTable(await this.trainer.device.getServices());
  }

  get canErg(): boolean {
    return !!this.trainer?.capabilities.erg && this.trainer.state === 'connected';
  }

  get canSim(): boolean {
    return !!this.trainer?.capabilities.sim && this.trainer.state === 'connected';
  }

  async setErg(watts: number): Promise<void> {
    if (!this.trainer) return;
    try {
      await this.trainer.setErgPower(watts);
    } catch (err) {
      log('warn', `ERG ${watts} W fehlgeschlagen: ${errorMessage(err)}`);
    }
  }

  async setSim(params: TrainerSimParams): Promise<void> {
    if (!this.trainer) return;
    try {
      await this.trainer.setSimulation(params);
    } catch (err) {
      log('warn', `SIM ${params.gradePercent.toFixed(1)} % fehlgeschlagen: ${errorMessage(err)}`);
    }
  }

  private pushPower(p: number): void {
    const now = Date.now();
    this.powerWindow.push({ t: now, p });
    this.powerWindow = this.powerWindow.filter((s) => now - s.t <= 3000);
  }

  private trainerCadence?: number;
  private trainerHr?: number;
  private trainerSpeed?: number;

  private recompute(fromTrainer: { trainerCadence?: number; trainerHr?: number; trainerSpeed?: number }): void {
    if ('trainerCadence' in fromTrainer) this.trainerCadence = fromTrainer.trainerCadence;
    if ('trainerHr' in fromTrainer) this.trainerHr = fromTrainer.trainerHr;
    if ('trainerSpeed' in fromTrainer) this.trainerSpeed = fromTrainer.trainerSpeed;

    const now = Date.now();
    const stale = now - this.lastTrainerData > STALE_MS;
    const latest = this.powerWindow.at(-1)?.p ?? 0;
    const avg = this.powerWindow.length ? this.powerWindow.reduce((a, s) => a + s.p, 0) / this.powerWindow.length : 0;

    const sensorFresh = this.sensorCadence && now - this.sensorCadence.t < STALE_MS;
    const useSensor = sensorFresh && (settingsStore.get().preferCadenceSensor || this.trainerCadence === undefined);
    const cadence = useSensor ? this.sensorCadence!.value : stale ? 0 : (this.trainerCadence ?? 0);

    const hrmFresh = this.hrmValue && now - this.hrmValue.t < 5000;
    const heartRate = hrmFresh ? this.hrmValue!.value : this.trainerHr;

    this.metrics.set({
      timestamp: now,
      power: stale ? 0 : latest,
      power3s: stale ? 0 : avg,
      cadence,
      heartRate,
      trainerSpeedKmh: stale ? undefined : this.trainerSpeed,
      stale,
      cadenceSource: useSensor ? 'sensor' : this.trainerCadence !== undefined ? 'trainer' : null,
      heartRateSource: hrmFresh ? 'hrm' : this.trainerHr !== undefined ? 'trainer' : null,
    });
  }

  private checkStale(): void {
    const m = this.metrics.get();
    const stale = Date.now() - this.lastTrainerData > STALE_MS;
    if (stale !== m.stale || (stale && m.power !== 0)) {
      if (stale) this.powerWindow = [];
      this.recompute({});
    }
  }
}

export const deviceManager = new DeviceManager();
