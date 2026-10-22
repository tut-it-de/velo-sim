/**
 * Platform-neutral BLE abstraction. Implemented by
 *  - WebBluetoothTransport (Chrome/Edge on Windows/macOS, Electron)
 *  - CapacitorBleTransport (iPad via @capacitor-community/bluetooth-le)
 *  - SimulatedTransport (development and tests, no hardware needed)
 * All UUIDs are 128-bit lowercase strings (see normalizeUuid).
 */

export interface CharacteristicProperties {
  read: boolean;
  write: boolean;
  writeWithoutResponse: boolean;
  notify: boolean;
  indicate: boolean;
}

export type NotificationListener = (value: DataView) => void;

export interface BleCharacteristic {
  readonly uuid: string;
  readonly properties: CharacteristicProperties;
  read(): Promise<DataView>;
  write(data: Uint8Array, withResponse?: boolean): Promise<void>;
  /** Enables notifications or indications. Resolves to a function that stops them. */
  startNotifications(listener: NotificationListener): Promise<() => Promise<void>>;
}

export interface BleService {
  readonly uuid: string;
  getCharacteristics(): Promise<BleCharacteristic[]>;
  getCharacteristic(uuid: string): Promise<BleCharacteristic | null>;
}

export interface BleDevice {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getServices(): Promise<BleService[]>;
  /** Called whenever the link drops (including after disconnect()). */
  onDisconnect(listener: () => void): () => void;
}

export interface DeviceRequest {
  /** The device must advertise at least one of these services … */
  services: string[];
  /** … or have a name starting with one of these prefixes. */
  namePrefixes?: string[];
  /** Extra services we want to access after connecting. */
  optionalServices?: string[];
}

export interface BleTransport {
  readonly id: 'web-bluetooth' | 'capacitor' | 'simulated';
  isAvailable(): Promise<boolean>;
  /** Shows the platform's device chooser. Rejects if the user cancels. */
  requestDevice(request: DeviceRequest): Promise<BleDevice>;
  /**
   * Looks for a matching device without a chooser (native apps only). A device from `preferIds` wins at once;
   * otherwise the strongest match after `timeoutMs`, or null.
   */
  scan?(request: DeviceRequest, options: { preferIds: string[]; timeoutMs: number }): Promise<BleDevice | null>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type BleLog = (level: LogLevel, message: string) => void;

export const noopLog: BleLog = () => {};
