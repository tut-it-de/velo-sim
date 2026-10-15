import { Emitter } from '../emitter';
import { dataViewToString } from '../bytes';
import { CHAR, SERVICE, describeUuid } from '../uuids';
import type { BleDevice, BleLog, BleService } from '../transport/types';
import type { ConnectionState, DeviceEvents, DeviceInformation } from './types';

export interface ManagedDeviceOptions {
  log?: BleLog;
  /** Reconnect automatically when the link drops (default true). */
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  /** Base delay between reconnect attempts, multiplied by the attempt number. */
  reconnectDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Base class for every BLE sensor: owns the connection lifecycle, notification
 * subscriptions and automatic reconnect. Subclasses implement `setup()`, which
 * runs after every (re)connect.
 */
export abstract class ManagedDevice<Data> extends Emitter<DeviceEvents<Data>> {
  protected readonly log: BleLog;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelayMs: number;
  private subscriptions: Array<() => Promise<void>> = [];
  private manuallyDisconnected = false;
  private reconnecting = false;
  private _state: ConnectionState = 'disconnected';
  info: DeviceInformation = {};

  constructor(
    readonly device: BleDevice,
    options: ManagedDeviceOptions = {},
  ) {
    super();
    this.log = options.log ?? (() => {});
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
    device.onDisconnect(() => void this.handleLinkLost());
  }

  get name(): string {
    return this.device.name;
  }

  get state(): ConnectionState {
    return this._state;
  }

  protected setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    this.emit('connection', state);
  }

  /** Subclass hook: discover services, subscribe, initialise. Runs after every connect. */
  protected abstract setup(services: Map<string, BleService>): Promise<void>;

  /** Subclass hook: forget per-connection state before a reconnect. */
  protected resetConnectionState(): void {}

  protected track(stop: () => Promise<void>): void {
    this.subscriptions.push(stop);
  }

  async start(): Promise<void> {
    this.manuallyDisconnected = false;
    this.setState('connecting');
    try {
      await this.connectAndSetup();
      this.setState('connected');
    } catch (err) {
      this.setState('disconnected');
      throw err;
    }
  }

  private async connectAndSetup(): Promise<void> {
    this.subscriptions = [];
    this.resetConnectionState();
    if (!this.device.connected) await this.device.connect();
    const services = await this.device.getServices();
    const byUuid = new Map(services.map((s) => [s.uuid, s]));
    this.log('debug', `${this.name}: Services: ${services.map((s) => describeUuid(s.uuid)).join(', ') || '—'}`);
    const dis = byUuid.get(SERVICE.deviceInformation);
    if (dis) this.info = await readDeviceInformation(dis);
    await this.setup(byUuid);
  }

  private async handleLinkLost(): Promise<void> {
    if (this.manuallyDisconnected || this.reconnecting) return;
    this.subscriptions = [];
    this.resetConnectionState();
    if (!this.autoReconnect) {
      this.log('warn', `${this.name}: Verbindung verloren`);
      this.setState('disconnected');
      return;
    }
    this.reconnecting = true;
    this.setState('reconnecting');
    this.log('warn', `${this.name}: Verbindung verloren – versuche neu zu verbinden …`);
    for (let attempt = 1; attempt <= this.maxReconnectAttempts && !this.manuallyDisconnected; attempt++) {
      await sleep(this.reconnectDelayMs * attempt);
      if (this.manuallyDisconnected) break;
      try {
        await this.connectAndSetup();
        this.reconnecting = false;
        this.log('info', `${this.name}: wieder verbunden (Versuch ${attempt})`);
        this.setState('connected');
        await this.afterReconnect();
        return;
      } catch (err) {
        this.log('warn', `${this.name}: Neuverbindung ${attempt}/${this.maxReconnectAttempts} fehlgeschlagen: ${errorMessage(err)}`);
      }
    }
    this.reconnecting = false;
    this.setState('disconnected');
  }

  /** Subclass hook: restore commands after a successful reconnect. */
  protected async afterReconnect(): Promise<void> {}

  async disconnect(): Promise<void> {
    this.manuallyDisconnected = true;
    const subs = this.subscriptions;
    this.subscriptions = [];
    for (const stop of subs) {
      try {
        await stop();
      } catch {
        // ignore
      }
    }
    try {
      await this.device.disconnect();
    } finally {
      this.setState('disconnected');
    }
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readDeviceInformation(service: BleService): Promise<DeviceInformation> {
  const info: DeviceInformation = {};
  const fields: Array<[keyof DeviceInformation, string]> = [
    ['manufacturer', CHAR.manufacturerName],
    ['model', CHAR.modelNumber],
    ['serial', CHAR.serialNumber],
    ['firmware', CHAR.firmwareRevision],
    ['hardware', CHAR.hardwareRevision],
  ];
  for (const [key, uuid] of fields) {
    try {
      const char = await service.getCharacteristic(uuid);
      if (char?.properties.read) info[key] = dataViewToString(await char.read());
    } catch {
      // optional characteristic, ignore
    }
  }
  return info;
}
