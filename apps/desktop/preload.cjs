// Exposes a minimal, typed bridge to the renderer (see apps/client/src/devices/platform.ts).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('veloDesktop', {
  platform: process.platform,
  onBluetoothDevices(callback) {
    const listener = (_event, devices) => callback(devices);
    ipcRenderer.on('bluetooth-devices', listener);
    return () => ipcRenderer.removeListener('bluetooth-devices', listener);
  },
  selectBluetoothDevice(deviceId) {
    ipcRenderer.send('bluetooth-select', deviceId);
  },
  cancelBluetoothRequest() {
    ipcRenderer.send('bluetooth-cancel');
  },
  openExternal(url) {
    ipcRenderer.send('open-external', String(url));
  },
});
