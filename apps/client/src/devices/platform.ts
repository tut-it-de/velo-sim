import { Capacitor } from '@capacitor/core';
import { CapacitorBleTransport, WebBluetoothTransport, type BleTransport } from '@velo/ble';

export interface DesktopBridge {
  platform: string;
  onBluetoothDevices(cb: (devices: Array<{ deviceId: string; deviceName: string }>) => void): () => void;
  selectBluetoothDevice(deviceId: string): void;
  cancelBluetoothRequest(): void;
  openExternal?(url: string): void;
}

declare global {
  interface Window {
    veloDesktop?: DesktopBridge;
  }
}

export type PlatformKind = 'ipad' | 'desktop' | 'browser';

export const platform: { kind: PlatformKind; label: string; bluetoothHint?: string } = (() => {
  if (Capacitor.isNativePlatform()) return { kind: 'ipad' as const, label: `App (${Capacitor.getPlatform()})` };
  if (typeof window !== 'undefined' && window.veloDesktop) {
    return { kind: 'desktop' as const, label: `Desktop (${window.veloDesktop.platform})` };
  }
  const hasWebBluetooth = typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  return {
    kind: 'browser' as const,
    label: 'Browser',
    bluetoothHint: hasWebBluetooth
      ? undefined
      : 'Dieser Browser kann kein Bluetooth. Bitte Chrome oder Edge verwenden – oder die Desktop- bzw. iPad-App.',
  };
})();

let realTransport: BleTransport | undefined;

/** Native BLE on iPad, Web Bluetooth everywhere else (Chrome, Edge, Electron). */
export function getBluetoothTransport(): BleTransport {
  realTransport ??= platform.kind === 'ipad' ? new CapacitorBleTransport() : new WebBluetoothTransport();
  return realTransport;
}
