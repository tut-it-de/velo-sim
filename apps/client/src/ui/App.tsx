import { useEffect, useState } from 'react';
import { settingsStore } from '../state/settings';
import { refreshAccount } from '../net/api';
import { refreshStravaStatus } from '../net/strava';
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
  const settings = useStore(settingsStore);
  useSimulatorKeys();

  useEffect(() => {
    // Sync wallet/garage and Strava link from the server when logged in.
    void refreshAccount()
      .catch(() => undefined)
      .then(() => refreshStravaStatus());
  }, []);

  return (
    <div className="app">
      <header className="topbar" hidden={immersive}>
        <button className="brand" onClick={() => setPage('ride')} aria-label="Velo Sim – Fahren">
          <span className="brand-name">Velo Sim</span>
        </button>
        <nav className="nav">
          {PAGES.map((p) => (
            <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)} aria-current={page === p.id ? 'page' : undefined}>
              {p.label}
              {p.id === 'settings' && settings.adminMode && <span className="admin-mark" title="Admin-Modus aktiv"> · Admin</span>}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="topbar-status">
          <StatusDot state={slots.trainer.state} label="Trainer" />
          <StatusDot state={slots.hrm.state} label="HF" />
        </div>
        <button className="wallet-chip" onClick={() => setPage('garage')} title="Watt-Taler – zur Garage">
          {formatCoins(balance(garage))} <span className="muted">Taler</span>
        </button>
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
