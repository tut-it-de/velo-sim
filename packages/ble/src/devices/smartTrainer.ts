import { toHex } from '../bytes';
import { CrankCadenceCalculator } from '../crankCadence';
import {
  DEFAULT_CRR,
  DEFAULT_CW,
  FtmsOpCode,
  FtmsResultCode,
  encodeIndoorBikeSimulation,
  encodeRequestControl,
  encodeSetTargetPower,
  encodeStartOrResume,
  ftmsResultName,
  parseControlPointResponse,
  parseFitnessMachineStatus,
} from '../ftms/controlPoint';
import { parseCyclingPowerMeasurement } from '../parsers/cyclingPower';
import { parseFtmsFeatures, type FtmsFeatures } from '../parsers/ftmsFeature';
import { parseIndoorBikeData } from '../parsers/indoorBikeData';
import { CHAR, SERVICE, describeUuid } from '../uuids';
import { encodeWahooErg, encodeWahooSimGrade, encodeWahooSimMode, encodeWahooUnlock } from '../wahoo/control';
import type { BleCharacteristic, BleService } from '../transport/types';
import { CommandQueue } from './commandQueue';
import { ManagedDevice, errorMessage, type ManagedDeviceOptions } from './managedDevice';
import type { TrainerCapabilities, TrainerData, TrainerProtocol, TrainerSimParams } from './types';

export interface SmartTrainerOptions extends ManagedDeviceOptions {
  /** How long to wait for an FTMS control point response before giving up (ms). */
  responseTimeoutMs?: number;
  /** Prefer the Wahoo legacy protocol even if FTMS is available (diagnostics only). */
  forceWahooProtocol?: boolean;
}

type LastCommand = { type: 'erg'; watts: number } | { type: 'sim'; params: TrainerSimParams } | undefined;

export class TrainerCommandError extends Error {
  override name = 'TrainerCommandError';
}

/**
 * A controllable smart trainer (KICKR Core and any FTMS trainer).
 *
 * Protocol selection after connecting:
 *  1. FTMS (0x1826) when present — the open standard.
 *  2. Wahoo legacy control characteristic inside the Cycling Power service.
 *  3. Plain Cycling Power — read-only, no ERG/SIM.
 *
 * Metrics are merged from Indoor Bike Data and Cycling Power Measurement:
 * Indoor Bike Data wins for every field it reports; crank revolutions from
 * Cycling Power fill in cadence when Indoor Bike Data has none.
 */
export class SmartTrainer extends ManagedDevice<TrainerData> {
  protocol: TrainerProtocol = 'power-only';
  capabilities: TrainerCapabilities = { erg: false, sim: false, power: false, cadence: false, speed: false };
  ftmsFeatures?: FtmsFeatures;

  private readonly responseTimeoutMs: number;
  private readonly forceWahoo: boolean;
  private readonly queue = new CommandQueue();
  private readonly cadenceCalc = new CrankCadenceCalculator();
  private ftmsControlPoint?: BleCharacteristic;
  private wahooControl?: BleCharacteristic;
  private wahooSimKey?: string;
  private pendingResponse?: { opCode: number; resolve: (code: number | null) => void };
  private ibdFields = { power: false, cadence: false, speed: false };
  private current: TrainerData = { timestamp: 0 };
  private lastCommand: LastCommand;

  constructor(device: SmartTrainer['device'], options: SmartTrainerOptions = {}) {
    super(device, options);
    this.responseTimeoutMs = options.responseTimeoutMs ?? 3000;
    this.forceWahoo = options.forceWahooProtocol ?? false;
  }

  /** Current merged metrics snapshot. */
  get data(): TrainerData {
    return this.current;
  }

  get targetDescription(): string {
    const c = this.lastCommand;
    if (!c) return '—';
    return c.type === 'erg' ? `ERG ${c.watts} W` : `SIM ${c.params.gradePercent.toFixed(1)} %`;
  }

  protected override resetConnectionState(): void {
    this.queue.clear();
    this.cadenceCalc.reset();
    this.ftmsControlPoint = undefined;
    this.wahooControl = undefined;
    this.wahooSimKey = undefined;
    this.pendingResponse?.resolve(null);
    this.pendingResponse = undefined;
    this.ibdFields = { power: false, cadence: false, speed: false };
  }

  protected override async setup(services: Map<string, BleService>): Promise<void> {
    const ftms = services.get(SERVICE.fitnessMachine);
    const cps = services.get(SERVICE.cyclingPower);
    const wahooChar = cps ? await cps.getCharacteristic(CHAR.wahooTrainerControl) : null;

    if (ftms && !(this.forceWahoo && wahooChar)) {
      await this.setupFtms(ftms);
    } else if (wahooChar) {
      await this.setupWahoo(wahooChar);
    } else {
      this.protocol = 'power-only';
      this.capabilities = { ...this.capabilities, erg: false, sim: false };
    }

    if (cps) await this.subscribeCyclingPower(cps);

    if (!ftms && !cps) {
      throw new Error('Kein Trainer-Service gefunden (weder FTMS noch Cycling Power).');
    }
    this.log(
      'info',
      `${this.name}: Protokoll ${this.protocol.toUpperCase()} · ERG ${this.capabilities.erg ? 'ja' : 'nein'} · SIM ${this.capabilities.sim ? 'ja' : 'nein'}`,
    );
  }

  protected override async afterReconnect(): Promise<void> {
    const c = this.lastCommand;
    if (!c) return;
    this.log('info', `${this.name}: stelle letzten Befehl wieder her (${this.targetDescription})`);
    try {
      if (c.type === 'erg') await this.setErgPower(c.watts);
      else await this.setSimulation(c.params);
    } catch (err) {
      this.log('warn', `${this.name}: Wiederherstellen fehlgeschlagen: ${errorMessage(err)}`);
    }
  }

  // ---------------------------------------------------------------- FTMS

  private async setupFtms(ftms: BleService): Promise<void> {
    this.protocol = 'ftms';
    const featureChar = await ftms.getCharacteristic(CHAR.fitnessMachineFeature);
    if (featureChar?.properties.read) {
      try {
        this.ftmsFeatures = parseFtmsFeatures(await featureChar.read());
        this.log('debug', `${this.name}: FTMS-Features ${JSON.stringify({ ...this.ftmsFeatures, raw: undefined })}`);
      } catch (err) {
        this.log('warn', `${this.name}: FTMS-Features nicht lesbar: ${errorMessage(err)}`);
      }
    }

    const ibd = await ftms.getCharacteristic(CHAR.indoorBikeData);
    if (ibd) {
      this.track(await ibd.startNotifications((v) => this.onIndoorBikeData(v)));
    } else {
      this.log('warn', `${this.name}: FTMS ohne Indoor Bike Data`);
    }

    const status = await ftms.getCharacteristic(CHAR.fitnessMachineStatus);
    if (status?.properties.notify) {
      this.track(
        await status.startNotifications((v) => {
          const s = parseFitnessMachineStatus(v);
          this.log('debug', `${this.name}: Status ${s.name}`);
          if (s.code === 0xff) this.log('warn', `${this.name}: Trainer hat die Steuerung entzogen`);
        }),
      );
    }

    const cp = await ftms.getCharacteristic(CHAR.fitnessMachineControlPoint);
    if (!cp) {
      this.log('warn', `${this.name}: FTMS ohne Control Point – nur Messwerte`);
      this.capabilities = { ...this.capabilities, erg: false, sim: false };
      return;
    }
    // Indications must be enabled before the first write, otherwise many trainers reject commands.
    this.track(await cp.startNotifications((v) => this.onControlPointResponse(v)));
    this.ftmsControlPoint = cp;

    const f = this.ftmsFeatures;
    this.capabilities = {
      ...this.capabilities,
      // Feature bits are optional in practice; assume support when the feature char is missing.
      erg: f ? f.targetPower : true,
      sim: f ? f.indoorBikeSimulation : true,
    };

    // Routed through the queue so a target command from the ride loop can never interleave.
    await this.queue.enqueue('control', async () => {
      await this.ftmsCommand(encodeRequestControl());
      await this.ftmsCommand(encodeStartOrResume(), { tolerateFailure: true });
    });
  }

  private onControlPointResponse(view: DataView): void {
    const res = parseControlPointResponse(view);
    if (!res) {
      this.log('debug', `${this.name}: Control Point: ${toHex(view)}`);
      return;
    }
    const pending = this.pendingResponse;
    if (pending && pending.opCode === res.requestOpCode) {
      this.pendingResponse = undefined;
      pending.resolve(res.resultCode);
    }
  }

  private waitForResponse(opCode: number): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingResponse?.opCode === opCode) this.pendingResponse = undefined;
        resolve(null);
      }, this.responseTimeoutMs);
      this.pendingResponse = {
        opCode,
        resolve: (code) => {
          clearTimeout(timer);
          resolve(code);
        },
      };
    });
  }

  private async ftmsCommand(payload: Uint8Array, opts: { tolerateFailure?: boolean; retried?: boolean } = {}): Promise<void> {
    const cp = this.ftmsControlPoint;
    if (!cp) throw new TrainerCommandError('Trainer ist nicht steuerbar');
    const opCode = payload[0] ?? 0;
    const response = this.waitForResponse(opCode);
    this.log('debug', `${this.name}: → ${toHex(payload)}`);
    await cp.write(payload, true);
    const code = await response;

    if (code === null) {
      // Some firmwares do not indicate reliably; carry on rather than stall the ride.
      this.log('warn', `${this.name}: keine Antwort auf Op-Code 0x${opCode.toString(16)}`);
      return;
    }
    if (code === FtmsResultCode.Success) return;

    if (code === FtmsResultCode.ControlNotPermitted && opCode !== FtmsOpCode.RequestControl && !opts.retried) {
      this.log('info', `${this.name}: Steuerung neu anfordern`);
      await this.ftmsCommand(encodeRequestControl());
      await this.ftmsCommand(payload, { ...opts, retried: true });
      return;
    }

    const msg = `Op-Code 0x${opCode.toString(16)} abgelehnt: ${ftmsResultName(code)}`;
    if (opts.tolerateFailure) {
      this.log('debug', `${this.name}: ${msg}`);
      return;
    }
    throw new TrainerCommandError(msg);
  }

  private onIndoorBikeData(view: DataView): void {
    let d;
    try {
      d = parseIndoorBikeData(view);
    } catch (err) {
      this.log('warn', `${this.name}: Indoor Bike Data fehlerhaft (${toHex(view)}): ${errorMessage(err)}`);
      return;
    }
    const next: TrainerData = { ...this.current, timestamp: Date.now() };
    if (d.power !== undefined) {
      this.ibdFields.power = true;
      next.power = Math.max(0, d.power);
    }
    if (d.cadence !== undefined) {
      this.ibdFields.cadence = true;
      next.cadence = d.cadence;
    }
    if (d.speedKmh !== undefined) {
      this.ibdFields.speed = true;
      next.speedKmh = d.speedKmh;
    }
    if (d.heartRate !== undefined && d.heartRate > 0) next.heartRate = d.heartRate;
    this.publish(next);
  }

  // ---------------------------------------------------------------- Wahoo legacy

  private async setupWahoo(char: BleCharacteristic): Promise<void> {
    this.protocol = 'wahoo';
    if (char.properties.notify || char.properties.indicate) {
      this.track(await char.startNotifications((v) => this.log('debug', `${this.name}: Wahoo ← ${toHex(v)}`)));
    }
    this.wahooControl = char;
    await this.queue.enqueue('control', () => this.wahooWrite(encodeWahooUnlock()));
    this.capabilities = { ...this.capabilities, erg: true, sim: true };
  }

  private async wahooWrite(payload: Uint8Array): Promise<void> {
    const char = this.wahooControl;
    if (!char) throw new TrainerCommandError('Trainer ist nicht steuerbar');
    this.log('debug', `${this.name}: Wahoo → ${toHex(payload)}`);
    await char.write(payload, true);
  }

  // ---------------------------------------------------------------- Cycling Power

  private async subscribeCyclingPower(cps: BleService): Promise<void> {
    const m = await cps.getCharacteristic(CHAR.cyclingPowerMeasurement);
    if (!m) return;
    this.track(await m.startNotifications((v) => this.onCyclingPower(v)));
  }

  private onCyclingPower(view: DataView): void {
    let d;
    try {
      d = parseCyclingPowerMeasurement(view);
    } catch (err) {
      this.log('warn', `${this.name}: Cycling Power fehlerhaft (${toHex(view)}): ${errorMessage(err)}`);
      return;
    }
    const now = Date.now();
    const next: TrainerData = { ...this.current, timestamp: now };
    if (!this.ibdFields.power) next.power = Math.max(0, d.power);
    if (d.crank && !this.ibdFields.cadence) {
      next.cadence = this.cadenceCalc.update(d.crank.revolutions, d.crank.eventTime, now);
    }
    this.publish(next);
  }

  private publish(next: TrainerData): void {
    this.current = next;
    this.capabilities.power ||= next.power !== undefined;
    this.capabilities.cadence ||= next.cadence !== undefined;
    this.capabilities.speed ||= next.speedKmh !== undefined;
    this.emit('data', next);
  }

  // ---------------------------------------------------------------- public control API

  /** ERG mode: the trainer holds `watts` regardless of cadence or virtual grade. */
  setErgPower(watts: number): Promise<void> {
    this.lastCommand = { type: 'erg', watts: Math.round(watts) };
    if (!this.capabilities.erg) return Promise.reject(new TrainerCommandError('Trainer unterstützt keinen ERG-Modus'));
    return this.queue.enqueue('target', async () => {
      if (this.protocol === 'ftms') await this.ftmsCommand(encodeSetTargetPower(watts));
      else await this.wahooWrite(encodeWahooErg(watts));
      this.wahooSimKey = undefined;
    });
  }

  /** SIM mode: the trainer simulates the given road grade (already scaled by trainer difficulty). */
  setSimulation(params: TrainerSimParams): Promise<void> {
    this.lastCommand = { type: 'sim', params: { ...params } };
    if (!this.capabilities.sim) return Promise.reject(new TrainerCommandError('Trainer unterstützt keinen SIM-Modus'));
    return this.queue.enqueue('target', async () => {
      if (this.protocol === 'ftms') {
        await this.ftmsCommand(encodeIndoorBikeSimulation(params));
        return;
      }
      const sim = {
        weightKg: params.totalWeightKg ?? 83,
        crr: params.crr ?? DEFAULT_CRR,
        windResistance: params.cwKgPerM ?? DEFAULT_CW,
      };
      const key = JSON.stringify(sim);
      if (this.wahooSimKey !== key) {
        await this.wahooWrite(encodeWahooSimMode(sim));
        this.wahooSimKey = key;
      }
      await this.wahooWrite(encodeWahooSimGrade(params.gradePercent));
    });
  }

  /** Summary for the diagnostics panel. */
  describe(): string {
    const info = this.info;
    return [
      `Gerät: ${this.name}`,
      info.manufacturer && `Hersteller: ${info.manufacturer}`,
      info.model && `Modell: ${info.model}`,
      info.firmware && `Firmware: ${info.firmware}`,
      `Protokoll: ${this.protocol}`,
      `ERG: ${this.capabilities.erg}, SIM: ${this.capabilities.sim}`,
      this.ftmsFeatures && `FTMS-Features: machine=0x${this.ftmsFeatures.raw.machine.toString(16)} target=0x${this.ftmsFeatures.raw.target.toString(16)}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
}

/** Lists every service and characteristic of a connected device (for the diagnostics view). */
export async function dumpGattTable(services: BleService[]): Promise<string> {
  const lines: string[] = [];
  for (const s of services) {
    lines.push(describeUuid(s.uuid));
    for (const c of await s.getCharacteristics()) {
      const p = c.properties;
      const flags = [p.read && 'read', p.write && 'write', p.writeWithoutResponse && 'writeNoResp', p.notify && 'notify', p.indicate && 'indicate']
        .filter(Boolean)
        .join(',');
      lines.push(`  └ ${describeUuid(c.uuid)} [${flags}]`);
    }
  }
  return lines.join('\n');
}
