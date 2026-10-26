import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'de.tutit.velosim',
  appName: 'WFR',
  webDir: 'dist',
  ios: {
    contentInset: 'never',
  },
  plugins: {
    BluetoothLe: {
      displayStrings: {
        scanning: 'Suche Geräte …',
        cancel: 'Abbrechen',
        availableDevices: 'Gefundene Geräte',
        noDeviceFound: 'Kein Gerät gefunden',
      },
    },
  },
};

export default config;
