import { useEffect, useState, type ReactNode } from 'react';
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

/** 20×20 line icons for the navigation (stroke = currentColor). */
const ICONS: Record<Page, ReactNode> = {
  ride: (
    <>
      <circle cx="5" cy="14" r="3.5" />
      <circle cx="15" cy="14" r="3.5" />
      <path d="M5 14 8.5 7h5L15 14M8.5 7 11 14h4M12 4.5h2.5" />
    </>
  ),
  garage: <path d="M3 9.5 10 4l7 5.5V17H3zM7 17v-5h6v5" />,
  activities: <path d="M2.5 11h3l2-5 3.5 9 2.2-6 1.3 2h3" />,
  devices: (
    <>
      <rect x="4" y="3" width="12" height="14" rx="2.5" />
      <path d="M8 7.5a3 3 0 0 1 4 0M6.5 5.8a5.2 5.2 0 0 1 7 0" />
      <circle cx="10" cy="12.5" r="1.6" />
    </>
  ),
  settings: (
    <>
      <circle cx="10" cy="7" r="3.2" />
      <path d="M3.5 17.5c.8-3.3 3.4-5 6.5-5s5.7 1.7 6.5 5" />
    </>
  ),
};

const PAGES: Array<{ id: Page; label: string }> = [
  { id: 'ride', label: 'Fahren' },
  { id: 'garage', label: 'Garage' },
  { id: 'activities', label: 'Aktivitäten' },
  { id: 'devices', label: 'Geräte' },
  { id: 'settings', label: 'Profil' },
];

function NavIcon({ page }: { page: Page }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[page]}
    </svg>
  );
}

export function App() {
  const [page, setPage] = useState<Page>('ride');
  const slots = useStore(deviceManager.slots);
  const { immersive } = useStore(uiStore);
  const garage = useStore(garageStore);
  const settings = useStore(settingsStore);
  const initials = settings.riderName.trim().slice(0, 2).toUpperCase() || 'VS';
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
          <span className="brand-mark" aria-hidden>
            <svg viewBox="0 0 24 24" width="22" height="22">
              <path d="M3 17 9.5 5h3L6.8 17zM10.5 17 17 5h3l-6.5 12z" fill="currentColor" />
            </svg>
          </span>
          <span className="brand-name">
            VELO<span>SIM</span>
          </span>
        </button>
        <nav className="nav">
          {PAGES.map((p) => (
            <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)} aria-current={page === p.id ? 'page' : undefined}>
              <NavIcon page={p.id} />
              <span>{p.label}</span>
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="topbar-status">
          <StatusDot state={slots.trainer.state} label="Trainer" />
          <StatusDot state={slots.hrm.state} label="HF" />
        </div>
        <button className="wallet-chip" onClick={() => setPage('garage')} title="Watt-Taler – zur Garage">
          <span className="coin" aria-hidden />
          {formatCoins(balance(garage))}
        </button>
        <button className="avatar-chip" onClick={() => setPage('settings')} title="Profil">
          {initials}
          {settings.adminMode && <span className="admin-dot" title="Admin-Modus aktiv" />}
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
