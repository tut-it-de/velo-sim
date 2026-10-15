import { useState } from 'react';
import { deviceManager } from '../devices/deviceManager';
import { useStore } from '../state/store';
import { BluetoothChooser } from './BluetoothChooser';
import { StatusDot } from './components';
import { DevicesPage } from './DevicesPage';
import { SettingsPage } from './SettingsPage';
import { useSimulatorKeys } from './useSimulatorKeys';

type Page = 'devices' | 'settings';

const PAGES: Array<{ id: Page; label: string }> = [
  { id: 'devices', label: 'Geräte' },
  { id: 'settings', label: 'Profil' },
];

export function App() {
  const [page, setPage] = useState<Page>('devices');
  const slots = useStore(deviceManager.slots);
  useSimulatorKeys();

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          VELO<span>SIM</span>
        </div>
        <nav>
          {PAGES.map((p) => (
            <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)}>
              {p.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="status">
          <StatusDot state={slots.trainer.state} label="Trainer" />
          <StatusDot state={slots.hrm.state} label="HF" />
        </div>
      </header>
      {page === 'devices' && <DevicesPage />}
      {page === 'settings' && <SettingsPage />}
      <BluetoothChooser />
    </div>
  );
}
