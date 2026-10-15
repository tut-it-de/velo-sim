import { useEffect, useState } from 'react';

type Device = { deviceId: string; deviceName: string };

/**
 * Electron has no built-in Web Bluetooth chooser: the main process forwards the
 * scan results here and we hand the selected device id back.
 */
export function BluetoothChooser() {
  const bridge = window.veloDesktop;
  const [devices, setDevices] = useState<Device[] | null>(null);

  useEffect(() => {
    if (!bridge) return;
    return bridge.onBluetoothDevices((list) => setDevices(list));
  }, [bridge]);

  if (!bridge || devices === null) return null;

  const close = () => setDevices(null);

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Gerät auswählen</h2>
        <p className="muted small">
          Trainer einschalten und kurz in die Pedale treten, damit er sichtbar wird. Die Liste aktualisiert sich automatisch.
        </p>
        <div className="device-list">
          {devices.length === 0 && <div className="muted">Suche …</div>}
          {devices.map((d) => (
            <button
              key={d.deviceId}
              onClick={() => {
                bridge.selectBluetoothDevice(d.deviceId);
                close();
              }}
            >
              {d.deviceName || 'Unbekanntes Gerät'} <span className="muted small">({d.deviceId.slice(-8)})</span>
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            bridge.cancelBluetoothRequest();
            close();
          }}
        >
          Abbrechen
        </button>
      </div>
    </div>
  );
}
