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

class WebBleCharacteristic implements BleCharacteristic {
  readonly uuid: string;
  readonly properties: CharacteristicProperties;

  constructor(private readonly char: BluetoothRemoteGATTCharacteristic) {
    this.uuid = normalizeUuid(char.uuid);
    const p = char.properties;
    this.properties = {
      read: p.read,
      write: p.write,
      writeWithoutResponse: p.writeWithoutResponse,
      notify: p.notify,
      indicate: p.indicate,
    };
  }

  async read(): Promise<DataView> {
    return this.char.readValue();
  }

  async write(data: Uint8Array, withResponse = true): Promise<void> {
    const buf = data.slice().buffer as ArrayBuffer;
    if (withResponse && this.char.writeValueWithResponse) {
      await this.char.writeValueWithResponse(buf);
    } else if (!withResponse && this.char.writeValueWithoutResponse) {
      await this.char.writeValueWithoutResponse(buf);
    } else {
      await this.char.writeValue(buf);
    }
  }

  async startNotifications(listener: NotificationListener): Promise<() => Promise<void>> {
    const handler = (event: Event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (value) listener(value);
    };
    this.char.addEventListener('characteristicvaluechanged', handler);
    await this.char.startNotifications();
    return async () => {
      this.char.removeEventListener('characteristicvaluechanged', handler);
      try {
        await this.char.stopNotifications();
      } catch {
        // link may already be gone
      }
    };
  }
}

class WebBleService implements BleService {
  readonly uuid: string;

  constructor(private readonly service: BluetoothRemoteGATTService) {
    this.uuid = normalizeUuid(service.uuid);
  }

  async getCharacteristics(): Promise<BleCharacteristic[]> {
    const chars = await this.service.getCharacteristics();
    return chars.map((c) => new WebBleCharacteristic(c));
  }

  async getCharacteristic(uuid: string): Promise<BleCharacteristic | null> {
    try {
      return new WebBleCharacteristic(await this.service.getCharacteristic(normalizeUuid(uuid)));
    } catch {
      return null;
    }
  }
}

class WebBleDevice implements BleDevice {
  private listeners = new Set<() => void>();

  constructor(private readonly device: BluetoothDevice) {
    device.addEventListener('gattserverdisconnected', () => {
      for (const l of [...this.listeners]) l();
    });
  }

  get id(): string {
    return this.device.id;
  }

  get name(): string {
    return this.device.name ?? 'Unbekanntes Gerät';
  }

  get connected(): boolean {
    return this.device.gatt?.connected ?? false;
  }

  async connect(): Promise<void> {
    if (!this.device.gatt) throw new Error('Gerät unterstützt kein GATT');
    await this.device.gatt.connect();
  }

  async disconnect(): Promise<void> {
    this.device.gatt?.disconnect();
  }

  async getServices(): Promise<BleService[]> {
    if (!this.device.gatt?.connected) throw new Error('Nicht verbunden');
    const services = await this.device.gatt.getPrimaryServices();
    return services.map((s) => new WebBleService(s));
  }

  onDisconnect(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Web Bluetooth: Chrome/Edge on Windows and macOS, and Electron (with a device chooser in the main process). */
export class WebBluetoothTransport implements BleTransport {
  readonly id = 'web-bluetooth' as const;

  async isAvailable(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.bluetooth) return false;
    try {
      return await navigator.bluetooth.getAvailability();
    } catch {
      return true;
    }
  }

  async requestDevice(request: DeviceRequest): Promise<BleDevice> {
    if (typeof navigator === 'undefined' || !navigator.bluetooth) {
      throw new Error('Web Bluetooth ist in diesem Browser nicht verfügbar. Bitte Chrome oder Edge verwenden.');
    }
    const services = request.services.map(normalizeUuid);
    const filters: BluetoothLEScanFilter[] = [
      ...services.map((s) => ({ services: [s] })),
      ...(request.namePrefixes ?? []).map((namePrefix) => ({ namePrefix })),
    ];
    const optionalServices = [...new Set([...services, ...(request.optionalServices ?? []).map(normalizeUuid)])];
    const device = await navigator.bluetooth.requestDevice({ filters, optionalServices });
    return new WebBleDevice(device);
  }
}
