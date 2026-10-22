import {
  HEART_RATE_REQUEST,
  SimulatedTransport,
  TRAINER_REQUEST,
  ZWIFT_SHIFTER_REQUEST,
  requestZwiftShifter,
  type ZwiftShifter,
  dumpGattTable,
  errorMessage,
  requestCadenceSensor,
  requestHeartRateMonitor,
  requestTrainer,
  type BleDevice,
  type BleTransport,
  type CadenceSensor,
  type ConnectionState,
  type HeartRateMonitor,
  type SmartTrainer,
  type TrainerSimParams,
} from '@velo/ble';
import { log } from '../state/log';
import { settingsStore, updateSettings } from '../state/settings';
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
  /** Zwift Click / Play / Ride for virtual shifting (always real Bluetooth, also in simulator mode). */
  readonly shifterSlot = new Store<SlotState>(disconnected);
  private shifter?: ZwiftShifter;
  private shiftListeners = new Set<(delta: 1 | -1) => void>();

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

  /**
   * Finds trainer and heart rate strap without a chooser (iPad app): remembered devices first, otherwise the
   * nearest one. Returns quietly when nothing is found or the platform cannot scan.
   */
  async autoConnect(): Promise<void> {
    if (this.autoConnecting) return this.autoConnecting;
    this.autoConnecting = (async () => {
      const transport = this.transport();
      if (!transport.scan || transport.id === 'simulated' || !(await transport.isAvailable())) return;
      const known = settingsStore.get().knownDevices;
      if (known.shifter && this.shifterSlot.get().state === 'disconnected') {
        const found = await getBluetoothTransport()
          .scan?.(ZWIFT_SHIFTER_REQUEST, { preferIds: [known.shifter], timeoutMs: 3000 })
          .catch(() => null);
        if (found?.id === known.shifter) await this.connectShifter(found);
      }
      for (const slot of ['trainer', 'hrm'] as const) {
        if (this.slots.get()[slot].state !== 'disconnected') continue;
        this.patchSlot(slot, { state: 'connecting', error: undefined });
        const found = await transport
          .scan(slot === 'trainer' ? TRAINER_REQUEST : HEART_RATE_REQUEST, { preferIds: known[slot] ? [known[slot]] : [], timeoutMs: 4000 })
          .catch(() => null);
        if (found) await this.connect(slot, found);
        else this.patchSlot(slot, { state: 'disconnected' });
      }
    })().finally(() => (this.autoConnecting = undefined));
    return this.autoConnecting;
  }
  private autoConnecting?: Promise<void>;

  async connect(slot: DeviceSlot, found?: BleDevice): Promise<void> {
    const transport = this.transport();
    const simulated = transport.id === 'simulated';
    this.patchSlot(slot, { state: 'connecting', error: undefined, simulated });
    try {
      if (slot === 'trainer') {
        await this.trainer?.disconnect();
        const t = await requestTrainer(transport, { log }, found);
        this.trainer = t;
        t.on('data', (d) => {
          this.lastTrainerData = Date.now();
          this.pushPower(d.power ?? 0);
          this.recompute({ trainerCadence: d.cadence, trainerHr: d.heartRate, trainerSpeed: d.speedKmh });
        });
        t.on('connection', (state) => this.patchSlot('trainer', { state }));
        this.patchSlot('trainer', { state: 'connected', name: t.name });
        this.remember('trainer', t.device.id, simulated);
        log('info', t.describe().replace(/\n/g, ' · '));
      } else if (slot === 'hrm') {
        await this.hrm?.disconnect();
        const h = await requestHeartRateMonitor(transport, { log }, found);
        this.hrm = h;
        h.on('data', (d) => {
          this.hrmValue = { value: d.heartRate, t: Date.now() };
          this.recompute({});
        });
        h.on('connection', (state) => this.patchSlot('hrm', { state }));
        this.patchSlot('hrm', { state: 'connected', name: h.name });
        this.remember('hrm', h.device.id, simulated);
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

  /** Called with +1 (heavier) or −1 (lighter) for every shift, from the remote, mouse or keyboard. */
  onShift(listener: (delta: 1 | -1) => void): () => void {
    this.shiftListeners.add(listener);
    return () => this.shiftListeners.delete(listener);
  }

  shift(delta: 1 | -1): void {
    for (const l of this.shiftListeners) l(delta);
  }

  async connectShifter(found?: BleDevice): Promise<void> {
    this.shifterSlot.set({ state: 'connecting' });
    try {
      await this.shifter?.disconnect();
      const s = await requestZwiftShifter(getBluetoothTransport(), { log }, found);
      this.shifter = s;
      s.on('data', (d) => this.shift(d.shift));
      s.on('connection', (state) => this.shifterSlot.set((x) => ({ ...x, state })));
      this.shifterSlot.set({ state: 'connected', name: s.name });
      this.remember('shifter', s.device.id, false);
    } catch (err) {
      const msg = errorMessage(err);
      const cancelled = /cancel|abgebrochen|User cancelled|chooser/i.test(msg);
      this.shifterSlot.set({ state: 'disconnected', error: cancelled ? undefined : msg });
      if (!cancelled) log('error', `Schalter verbinden fehlgeschlagen: ${msg}`);
    }
  }

  async disconnectShifter(): Promise<void> {
    await this.shifter?.disconnect();
    this.shifter = undefined;
    this.shifterSlot.set(disconnected);
  }

  private remember(slot: 'trainer' | 'hrm' | 'shifter', id: string, simulated: boolean): void {
    if (simulated) return;
    updateSettings({ knownDevices: { ...settingsStore.get().knownDevices, [slot]: id } });
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

  /**
   * Switches between the simulator and real Bluetooth devices. Everything connected through the
   * other transport is disconnected first, so "Verbinden" never reuses a device of the wrong kind.
   */
  async setSimulator(on: boolean): Promise<void> {
    if (settingsStore.get().useSimulator === on) return;
    const slots = this.slots.get();
    await Promise.all((Object.keys(slots) as DeviceSlot[]).filter((k) => slots[k].state !== 'disconnected').map((k) => this.disconnect(k)));
    updateSettings({ useSimulator: on });
    log('info', on ? 'Simulator-Modus an' : 'Simulator-Modus aus – Verbinden nutzt Bluetooth');
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
