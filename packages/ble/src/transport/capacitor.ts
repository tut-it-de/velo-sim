import { normalizeUuid } from '../uuids';
import type {
  BleCharacteristic,
  BleDevice,
  BleService,
  BleTransport,
  CharacteristicProperties,
  DeviceRequest,
  NotificationListener,
} from './types';

type BleClientType = (typeof import('@capacitor-community/bluetooth-le'))['BleClient'];

let clientPromise: Promise<BleClientType> | undefined;

/** Loads and initialises the native plugin lazily so web/desktop builds never touch it. */
function getClient(): Promise<BleClientType> {
  clientPromise ??= import('@capacitor-community/bluetooth-le').then(async (mod) => {
    await mod.BleClient.initialize({ androidNeverForLocation: true });
    return mod.BleClient;
  });
  return clientPromise;
}

class CapacitorCharacteristic implements BleCharacteristic {
  constructor(
    private readonly client: BleClientType,
    private readonly deviceId: string,
    private readonly serviceUuid: string,
    readonly uuid: string,
    readonly properties: CharacteristicProperties,
  ) {}

  read(): Promise<DataView> {
    return this.client.read(this.deviceId, this.serviceUuid, this.uuid);
  }

  async write(data: Uint8Array, withResponse = true): Promise<void> {
    const view = new DataView(data.slice().buffer);
    if (withResponse) await this.client.write(this.deviceId, this.serviceUuid, this.uuid, view);
    else await this.client.writeWithoutResponse(this.deviceId, this.serviceUuid, this.uuid, view);
  }

  async startNotifications(listener: NotificationListener): Promise<() => Promise<void>> {
    await this.client.startNotifications(this.deviceId, this.serviceUuid, this.uuid, listener);
    return async () => {
      try {
        await this.client.stopNotifications(this.deviceId, this.serviceUuid, this.uuid);
      } catch {
        // link may already be gone
      }
    };
  }
}

class CapacitorService implements BleService {
  constructor(
    readonly uuid: string,
    private readonly chars: BleCharacteristic[],
  ) {}

  async getCharacteristics(): Promise<BleCharacteristic[]> {
    return this.chars;
  }

  async getCharacteristic(uuid: string): Promise<BleCharacteristic | null> {
    const n = normalizeUuid(uuid);
    return this.chars.find((c) => c.uuid === n) ?? null;
  }
}

class CapacitorDevice implements BleDevice {
  private listeners = new Set<() => void>();
  private isConnected = false;

  constructor(
    private readonly client: BleClientType,
    readonly id: string,
    readonly name: string,
  ) {}

  get connected(): boolean {
    return this.isConnected;
  }

  async connect(): Promise<void> {
    await this.client.connect(this.id, () => {
      this.isConnected = false;
      for (const l of [...this.listeners]) l();
    });
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect(this.id);
    this.isConnected = false;
  }

  async getServices(): Promise<BleService[]> {
    const services = await this.client.getServices(this.id);
    return services.map((s) => {
      const serviceUuid = normalizeUuid(s.uuid);
      const chars = s.characteristics.map(
        (c) =>
          new CapacitorCharacteristic(this.client, this.id, serviceUuid, normalizeUuid(c.uuid), {
            read: c.properties.read,
            write: c.properties.write,
            writeWithoutResponse: c.properties.writeWithoutResponse,
            notify: c.properties.notify,
            indicate: c.properties.indicate,
          }),
      );
      return new CapacitorService(serviceUuid, chars);
    });
  }

  onDisconnect(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Native BLE on iPad (and Android) through Capacitor. */
export class CapacitorBleTransport implements BleTransport {
  readonly id = 'capacitor' as const;

  async isAvailable(): Promise<boolean> {
    try {
      const client = await getClient();
      return await client.isEnabled();
    } catch {
      return false;
    }
  }

  async requestDevice(request: DeviceRequest): Promise<BleDevice> {
    const client = await getClient();
    const device = await client.requestDevice({
      services: request.services.map(normalizeUuid),
      optionalServices: (request.optionalServices ?? []).map(normalizeUuid),
    });
    return new CapacitorDevice(client, device.deviceId, device.name ?? 'Unbekanntes Gerät');
  }

  async scan(request: DeviceRequest, { preferIds, timeoutMs }: { preferIds: string[]; timeoutMs: number }): Promise<BleDevice | null> {
    const client = await getClient();
    const services = request.services.map(normalizeUuid);
    const prefixes = request.namePrefixes ?? [];
    let best: { id: string; name: string; rssi: number } | undefined;
    let done: () => void = () => {};
    const finished = new Promise<void>((resolve) => (done = resolve));
    // No service filter: some straps only show their heart-rate service after connecting.
    await client.requestLEScan({}, (r) => {
      const name = r.localName ?? r.device.name ?? '';
      const matches = preferIds.includes(r.device.deviceId) || (r.uuids ?? []).some((u) => services.includes(normalizeUuid(u))) || prefixes.some((p) => name.startsWith(p));
      if (!matches) return;
      const rssi = r.rssi ?? -127;
      if (preferIds.includes(r.device.deviceId)) {
        best = { id: r.device.deviceId, name: name || 'Unbekanntes Gerät', rssi: Infinity };
        done();
      } else if (!best || rssi > best.rssi) best = { id: r.device.deviceId, name: name || 'Unbekanntes Gerät', rssi };
    });
    const timer = setTimeout(done, timeoutMs);
    await finished;
    clearTimeout(timer);
    await client.stopLEScan().catch(() => undefined);
    return best ? new CapacitorDevice(client, best.id, best.name) : null;
  }
}
