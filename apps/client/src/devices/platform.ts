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

export interface BluetoothHint {
  text: string;
  links?: Array<{ href: string; label: string }>;
}

/** HTTPS port of the Velo server next to its HTTP port (apps/server, HTTPS_PORT). */
const HTTPS_PORT = 8443;

/** Why this browser has no Web Bluetooth, and where to go instead. */
function bluetoothHintFor(): BluetoothHint {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    return {
      text:
        'Auf iPhone und iPad kann kein Browser Bluetooth – auch Chrome nicht, Apple lässt es nicht zu. ' +
        'Nutze die iPad-App oder den Browser „Bluefy“ aus dem App Store.',
    };
  }
  if (!window.isSecureContext && location.protocol === 'http:') {
    const https = `https://${location.hostname}:${HTTPS_PORT}${location.pathname}${location.search}${location.hash}`;
    return {
      text:
        'Bluetooth geht im Browser nur über eine sichere Verbindung (https://). Öffne die HTTPS-Adresse. ' +
        'Beim ersten Mal auf dem Handy das Velo-Zertifikat installieren (Android: Einstellungen → Sicherheit → ' +
        'Verschlüsselung & Anmeldedaten → Zertifikat installieren → CA-Zertifikat), sonst sperrt Chrome Bluetooth trotz https.',
      links: [
        { href: https, label: 'Zur HTTPS-Adresse' },
        { href: '/velo-ca.crt', label: 'Zertifikat laden' },
      ],
    };
  }
  return { text: 'Dieser Browser kann kein Bluetooth. Bitte Chrome oder Edge verwenden – oder die Desktop- bzw. iPad-App.' };
}

export const platform: { kind: PlatformKind; label: string; bluetoothHint?: BluetoothHint } = (() => {
  if (Capacitor.isNativePlatform()) return { kind: 'ipad' as const, label: `App (${Capacitor.getPlatform()})` };
  if (typeof window !== 'undefined' && window.veloDesktop) {
    return { kind: 'desktop' as const, label: `Desktop (${window.veloDesktop.platform})` };
  }
  const hasWebBluetooth = typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  return {
    kind: 'browser' as const,
    label: 'Browser',
    bluetoothHint: hasWebBluetooth ? undefined : bluetoothHintFor(),
  };
})();

let realTransport: BleTransport | undefined;

/** Native BLE on iPad, Web Bluetooth everywhere else (Chrome, Edge, Electron). */
export function getBluetoothTransport(): BleTransport {
  realTransport ??= platform.kind === 'ipad' ? new CapacitorBleTransport() : new WebBluetoothTransport();
  return realTransport;
}
