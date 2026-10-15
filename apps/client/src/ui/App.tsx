import { useState } from 'react';
import { deviceManager } from '../devices/deviceManager';
import { useStore } from '../state/store';
import { uiStore } from '../state/ui';
import { ActivitiesPage } from './ActivitiesPage';
import { BluetoothChooser } from './BluetoothChooser';
import { StatusDot } from './components';
import { DevicesPage } from './DevicesPage';
import { GaragePage } from './GaragePage';
import { balance, garageStore } from '../state/garage';
import { formatCoins } from '@velo/equipment';
import { RidePage } from './RidePage';
import { SettingsPage } from './SettingsPage';
import { useSimulatorKeys } from './useSimulatorKeys';

type Page = 'ride' | 'garage' | 'activities' | 'devices' | 'settings';

const PAGES: Array<{ id: Page; label: string }> = [
  { id: 'ride', label: 'Fahren' },
  { id: 'garage', label: 'Garage' },
  { id: 'activities', label: 'Aktivitäten' },
  { id: 'devices', label: 'Geräte' },
  { id: 'settings', label: 'Profil' },
];

export function App() {
  const [page, setPage] = useState<Page>('ride');
  const slots = useStore(deviceManager.slots);
  const { immersive } = useStore(uiStore);
  const garage = useStore(garageStore);
  useSimulatorKeys();

  return (
    <div className="app">
      <header className="topbar" hidden={immersive}>
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
        <button className="wallet-chip" onClick={() => setPage('garage')} title="Watt-Taler – zur Garage">
          🪙 {formatCoins(balance(garage))}
        </button>
        <div className="status">
          <StatusDot state={slots.trainer.state} label="Trainer" />
          <StatusDot state={slots.hrm.state} label="HF" />
        </div>
      </header>
      {page === 'ride' && <RidePage />}
      {page === 'garage' && <GaragePage />}
      {page === 'activities' && <ActivitiesPage />}
      {page === 'devices' && <DevicesPage />}
      {page === 'settings' && <SettingsPage />}
      <BluetoothChooser />
    </div>
  );
}
