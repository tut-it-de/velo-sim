import { ByteWriter } from '../bytes';
import { CHAR, SERVICE } from '../uuids';
import type {
  BleCharacteristic,
  BleDevice,
  BleService,
  BleTransport,
  CharacteristicProperties,
  DeviceRequest,
  NotificationListener,
} from '../transport/types';

/**
 * A software BLE trainer that speaks real FTMS / Wahoo / Cycling Power bytes.
 * The app talks to it through exactly the same code path as to the KICKR, so
 * everything above the transport is exercised without hardware — in unit tests,
 * during development and for multiplayer bots later on.
 */

const props = (p: Partial<CharacteristicProperties>): CharacteristicProperties => ({
  read: false,
  write: false,
  writeWithoutResponse: false,
  notify: false,
  indicate: false,
  ...p,
});

class FakeCharacteristic implements BleCharacteristic {
  private listeners = new Set<NotificationListener>();

  constructor(
    readonly uuid: string,
    readonly properties: CharacteristicProperties,
    private readonly handlers: { read?: () => DataView; write?: (data: Uint8Array) => void } = {},
  ) {}

  async read(): Promise<DataView> {
    if (!this.handlers.read) throw new Error('not readable');
    return this.handlers.read();
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.handlers.write) throw new Error('not writable');
    this.handlers.write(data);
  }

  async startNotifications(listener: NotificationListener): Promise<() => Promise<void>> {
    this.listeners.add(listener);
    return async () => {
      this.listeners.delete(listener);
    };
  }

  notify(view: DataView): void {
    for (const l of [...this.listeners]) l(view);
  }

  clearListeners(): void {
    this.listeners.clear();
  }
}

class FakeService implements BleService {
  constructor(
    readonly uuid: string,
    readonly chars: FakeCharacteristic[],
  ) {}

  async getCharacteristics(): Promise<BleCharacteristic[]> {
    return this.chars;
  }

  async getCharacteristic(uuid: string): Promise<BleCharacteristic | null> {
    return this.chars.find((c) => c.uuid === uuid) ?? null;
  }
}

const text = (s: string) => new DataView(new TextEncoder().encode(s).buffer);

abstract class FakeDevice implements BleDevice {
  connected = false;
  protected services: FakeService[] = [];
  private disconnectListeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly tickMs: number,
    private readonly autoTick: boolean,
  ) {}

  async connect(): Promise<void> {
    this.connected = true;
    this.onConnect();
    if (this.autoTick) {
      clearInterval(this.timer);
      let last = Date.now();
      this.timer = setInterval(() => {
        const now = Date.now();
        this.tick(now - last);
        last = now;
      }, this.tickMs);
    }
  }

  async disconnect(): Promise<void> {
    this.dropLink();
  }

  /** Simulates the trainer going out of range / BLE drop. */
  simulateLinkLoss(): void {
    this.dropLink();
  }

  private dropLink(): void {
    if (!this.connected) return;
    clearInterval(this.timer);
    this.connected = false;
    for (const s of this.services) for (const c of s.chars) c.clearListeners();
    for (const l of [...this.disconnectListeners]) l();
  }

  async getServices(): Promise<BleService[]> {
    if (!this.connected) throw new Error('Nicht verbunden');
    return this.services;
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  protected onConnect(): void {}

  abstract tick(dtMs: number): void;
}

export type SimulatedProfile = 'ftms' | 'wahoo-legacy';

export interface SimulatedTrainerOptions {
  /** 'ftms' = modern firmware, 'wahoo-legacy' = only Cycling Power + Wahoo control. */
  profile?: SimulatedProfile;
  name?: string;
  /** Emit data on a timer (default true). Tests set false and call tick() manually. */
  autoTick?: boolean;
  tickMs?: number;
  /** Add measurement noise (default true). */
  noise?: boolean;
}

export type SimulatedMode = 'idle' | 'erg' | 'sim';

export class SimulatedTrainerDevice extends FakeDevice {
  readonly profile: SimulatedProfile;
  readonly noise: boolean;
  mode: SimulatedMode = 'idle';
  targetPower = 0;
  gradePercent = 0;
  simWeightKg?: number;
  controlGranted = false;
  unlocked = false;
  /** What the virtual rider pushes in SIM/idle mode and how fast they spin. */
  rider = { power: 150, cadence: 88 };
  power = 0;
  cadence = 0;
  speedKmh = 0;
  /** Every control write in order — lets tests assert the exact bytes sent. */
  readonly writes: Uint8Array[] = [];

  private simTimeMs = 0;
  private crankRevs = 0;
  private crankFraction = 0;
  private crankEventTime = 0;
  private readonly ibd = new FakeCharacteristic(CHAR.indoorBikeData, props({ notify: true }));
  private readonly cpm = new FakeCharacteristic(CHAR.cyclingPowerMeasurement, props({ notify: true }));
  private readonly cp: FakeCharacteristic;
  private readonly wahoo: FakeCharacteristic;

  constructor(opts: SimulatedTrainerOptions = {}) {
    const profile = opts.profile ?? 'ftms';
    super(`sim-${profile}`, opts.name ?? (profile === 'ftms' ? 'SIM KICKR (FTMS)' : 'SIM KICKR (Wahoo)'), opts.tickMs ?? 250, opts.autoTick ?? true);
    this.profile = profile;
    this.noise = opts.noise ?? true;

    this.cp = new FakeCharacteristic(CHAR.fitnessMachineControlPoint, props({ write: true, indicate: true }), {
      write: (d) => this.onFtmsControl(d),
    });
    this.wahoo = new FakeCharacteristic(CHAR.wahooTrainerControl, props({ write: true, notify: true }), {
      write: (d) => this.onWahooControl(d),
    });

    const dis = new FakeService(SERVICE.deviceInformation, [
      new FakeCharacteristic(CHAR.manufacturerName, props({ read: true }), { read: () => text('velo-sim') }),
      new FakeCharacteristic(CHAR.modelNumber, props({ read: true }), { read: () => text('Simulierter Trainer') }),
      new FakeCharacteristic(CHAR.firmwareRevision, props({ read: true }), { read: () => text(profile === 'ftms' ? '9.9.9' : '1.0.0') }),
    ]);
    const cpsChars = [this.cpm, ...(profile === 'wahoo-legacy' ? [this.wahoo] : [])];
    const cps = new FakeService(SERVICE.cyclingPower, cpsChars);
    this.services = [dis, cps];
    if (profile === 'ftms') {
      const features = new ByteWriter()
        .uint32((1 << 1) | (1 << 14)) // cadence + power measurement
        .uint32((1 << 3) | (1 << 13)) // target power + indoor bike simulation
        .toDataView();
      this.services.push(
        new FakeService(SERVICE.fitnessMachine, [
          new FakeCharacteristic(CHAR.fitnessMachineFeature, props({ read: true }), { read: () => features }),
          this.ibd,
          this.cp,
          new FakeCharacteristic(CHAR.fitnessMachineStatus, props({ notify: true })),
        ]),
      );
    }
  }

  protected override onConnect(): void {
    this.controlGranted = false;
    this.unlocked = false;
  }

  setRider(r: Partial<{ power: number; cadence: number }>): void {
    this.rider = { ...this.rider, ...r };
  }

  /** Simulates another app grabbing control of the trainer. */
  revokeControl(): void {
    this.controlGranted = false;
  }

  private respondFtms(opCode: number, result: number): void {
    // Real trainers answer asynchronously; a microtask keeps the order realistic.
    queueMicrotask(() => this.cp.notify(new DataView(Uint8Array.of(0x80, opCode, result).buffer)));
  }

  private onFtmsControl(d: Uint8Array): void {
    if (!this.connected) throw new Error('GATT Server is disconnected');
    this.writes.push(d);
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const op = d[0] ?? 0xff;
    const needsControl = op !== 0x00;
    if (needsControl && !this.controlGranted && [0x01, 0x05, 0x07, 0x08, 0x11].includes(op)) {
      this.respondFtms(op, 0x05);
      return;
    }
    switch (op) {
      case 0x00:
        this.controlGranted = true;
        break;
      case 0x01:
        this.mode = 'idle';
        break;
      case 0x05:
        this.mode = 'erg';
        this.targetPower = view.getInt16(1, true);
        break;
      case 0x07:
      case 0x08:
        break;
      case 0x11:
        this.mode = 'sim';
        this.gradePercent = view.getInt16(3, true) / 100;
        break;
      default:
        this.respondFtms(op, 0x02);
        return;
    }
    this.respondFtms(op, 0x01);
  }

  private onWahooControl(d: Uint8Array): void {
    if (!this.connected) throw new Error('GATT Server is disconnected');
    this.writes.push(d);
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    const op = d[0] ?? 0xff;
    if (op === 0x20) {
      this.unlocked = d[1] === 0xee && d[2] === 0xfc;
    } else if (this.unlocked) {
      if (op === 0x42) {
        this.mode = 'erg';
        this.targetPower = view.getUint16(1, true);
      } else if (op === 0x43) {
        this.mode = 'sim';
        this.simWeightKg = view.getUint16(1, true) / 100;
      } else if (op === 0x46) {
        this.mode = 'sim';
        this.gradePercent = ((view.getUint16(1, true) * 2) / 0xffff - 1) * 100;
      }
    }
    queueMicrotask(() => this.wahoo.notify(new DataView(Uint8Array.of(0x01, op, this.unlocked ? 0x01 : 0x00).buffer)));
  }

  private jitter(amount: number): number {
    return this.noise ? (Math.random() * 2 - 1) * amount : 0;
  }

  tick(dtMs: number): void {
    if (!this.connected) return;
    this.simTimeMs += dtMs;
    const pedalling = this.rider.cadence > 0;
    const target = !pedalling ? 0 : this.mode === 'erg' ? this.targetPower : Math.max(0, this.rider.power);
    // First-order lag like a real flywheel / ERG controller.
    const alpha = 1 - Math.exp(-dtMs / 600);
    this.power += (target - this.power) * alpha;
    const reportedPower = Math.max(0, Math.round(this.power + this.jitter(this.power * 0.02)));
    this.cadence = pedalling ? Math.max(0, this.rider.cadence + this.jitter(1.5)) : 0;
    this.speedKmh = flatSpeedKmh(this.power);

    const revsPerSecond = this.cadence / 60;
    this.crankFraction += revsPerSecond * (dtMs / 1000);
    if (this.crankFraction >= 1) {
      const whole = Math.floor(this.crankFraction);
      this.crankFraction -= whole;
      this.crankRevs = (this.crankRevs + whole) & 0xffff;
      // Back-date the event to the exact moment the last revolution completed.
      const eventMs = this.simTimeMs - (this.crankFraction / revsPerSecond) * 1000;
      this.crankEventTime = Math.round(eventMs * 1.024) & 0xffff;
    }

    if (this.profile === 'ftms') {
      this.ibd.notify(
        new ByteWriter()
          .uint16(0x0044) // speed (bit0=0) + cadence + power
          .uint16(Math.round(this.speedKmh * 100))
          .uint16(Math.round(this.cadence * 2))
          .int16(reportedPower)
          .toDataView(),
      );
    }
    this.cpm.notify(
      new ByteWriter().uint16(0x0020).int16(reportedPower).uint16(this.crankRevs).uint16(this.crankEventTime).toDataView(),
    );
  }
}

/** Steady-state speed on flat road for a typical rider — only used for the trainer's speed field. */
function flatSpeedKmh(power: number): number {
  if (power <= 0) return 0;
  const k = 0.5 * 1.225 * 0.32;
  const rolling = 0.004 * 83 * 9.81;
  let v = 8;
  for (let i = 0; i < 20; i++) {
    const f = k * v ** 3 + rolling * v - power * 0.976;
    const df = 3 * k * v ** 2 + rolling;
    v -= f / df;
  }
  return Math.max(0, v * 3.6);
}

export class SimulatedHeartRateDevice extends FakeDevice {
  heartRate = 70;
  private readonly hrm = new FakeCharacteristic(CHAR.heartRateMeasurement, props({ notify: true }));
  private sinceLast = 0;

  constructor(
    private readonly powerSource: () => number,
    opts: { autoTick?: boolean } = {},
  ) {
    super('sim-hrm', 'SIM Herzfrequenz', 250, opts.autoTick ?? true);
    this.services = [new FakeService(SERVICE.heartRate, [this.hrm])];
  }

  tick(dtMs: number): void {
    if (!this.connected) return;
    const target = 65 + this.powerSource() * 0.38;
    this.heartRate += (target - this.heartRate) * (1 - Math.exp(-dtMs / 20000));
    this.sinceLast += dtMs;
    if (this.sinceLast >= 1000) {
      this.sinceLast = 0;
      this.hrm.notify(new DataView(Uint8Array.of(0x00, Math.round(this.heartRate)).buffer));
    }
  }
}

/** Hands out simulated devices instead of opening a Bluetooth chooser. */
export class SimulatedTransport implements BleTransport {
  readonly id = 'simulated' as const;
  trainer?: SimulatedTrainerDevice;
  heartRateMonitor?: SimulatedHeartRateDevice;

  constructor(private readonly opts: SimulatedTrainerOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async requestDevice(request: DeviceRequest): Promise<BleDevice> {
    if (request.services.includes(SERVICE.heartRate)) {
      this.heartRateMonitor ??= new SimulatedHeartRateDevice(() => this.trainer?.power ?? 0, { autoTick: this.opts.autoTick });
      return this.heartRateMonitor;
    }
    if (request.services.includes(SERVICE.fitnessMachine) || request.services.includes(SERVICE.cyclingPower)) {
      this.trainer ??= new SimulatedTrainerDevice(this.opts);
      return this.trainer;
    }
    throw new Error('Der Simulator bietet nur Trainer und Herzfrequenz an.');
  }
}
