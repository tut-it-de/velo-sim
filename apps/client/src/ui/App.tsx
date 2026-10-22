import { useEffect } from 'react';
import { settingsStore } from '../state/settings';
import { accountStore, refreshAccount } from '../net/api';
import { refreshStravaStatus } from '../net/strava';
import { activitiesStore, loadActivities } from '../state/activities';
import { useStore } from '../state/store';
import { pageStore, searchStore, uiStore, type Page } from '../state/ui';
import { ActivitiesPage } from './ActivitiesPage';
import { BluetoothChooser } from './BluetoothChooser';
import { DevicesPage } from './DevicesPage';
import { GaragePage } from './GaragePage';
import { Icon, type IconName } from './icons';
import { LoginPage } from './LoginPage';
import { balance, garageStore } from '../state/garage';
import { formatCoins } from '@velo/equipment';
import { RidePage } from './RidePage';
import { SettingsPage } from './SettingsPage';
import { useSimulatorKeys } from './useSimulatorKeys';

const PAGES: Array<{ id: Exclude<Page, 'login'>; label: string; icon: IconName }> = [
  { id: 'ride', label: 'Fahren', icon: 'ride' },
  { id: 'routes', label: 'Strecken', icon: 'routes' },
  { id: 'workouts', label: 'Workouts', icon: 'workouts' },
  { id: 'activities', label: 'Aktivitäten', icon: 'activities' },
  { id: 'garage', label: 'Garage', icon: 'garage' },
  { id: 'devices', label: 'Geräte', icon: 'devices' },
  { id: 'settings', label: 'Einstellungen', icon: 'settings' },
];

/** Rider level from the kilometres ridden: level n needs 25·n·(n−1) km (50, 150, 300, 500 …). */
export function riderLevel(totalKm: number): { level: number; progress: number; nextKm: number } {
  let level = 1;
  while (25 * (level + 1) * level <= totalKm) level++;
  const from = 25 * level * (level - 1);
  const to = 25 * (level + 1) * level;
  return { level, progress: (totalKm - from) / (to - from), nextKm: to };
}

export function App() {
  const page = useStore(pageStore);
  const setPage = (p: Page) => pageStore.set(p);
  const account = useStore(accountStore);
  const { immersive } = useStore(uiStore);
  const garage = useStore(garageStore);
  const settings = useStore(settingsStore);
  const search = useStore(searchStore);
  const activities = useStore(activitiesStore);
  useSimulatorKeys();

  useEffect(() => {
    // Sync wallet/garage and Strava link from the server when logged in.
    void refreshAccount()
      .catch(() => undefined)
      .then(() => refreshStravaStatus());
    void loadActivities();
  }, []);

  const name = account.user?.name ?? settings.riderName;
  const totalKm = activities.reduce((km, a) => km + a.summary.distanceM / 1000, 0);
  const lvl = riderLevel(totalKm);
  const ridePage = page === 'ride' || page === 'routes' || page === 'workouts';

  return (
    <div className={`app${immersive ? ' immersive' : ''}`}>
      <aside className="sidebar" hidden={immersive}>
        <button className="brand" onClick={() => setPage('ride')} aria-label="Velo Sim – Fahren">
          <span className="brand-mark">V</span>
          <span className="brand-name">Velo Sim</span>
        </button>
        <nav className="side-nav">
          {PAGES.map((p) => (
            <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)} aria-current={page === p.id ? 'page' : undefined}>
              <Icon name={p.icon} />
              <span>{p.label}</span>
              {p.id === 'settings' && settings.adminMode && <span className="admin-mark" title="Admin-Modus aktiv">Admin</span>}
            </button>
          ))}
        </nav>
        <button className="side-wallet" onClick={() => setPage('garage')} title="Watt-Taler – zur Garage">
          <span className="muted small">Watt-Taler</span>
          <strong>{settings.adminMode ? '∞' : formatCoins(balance(garage))}</strong>
        </button>
      </aside>

      <div className="main">
        <header className="topbar" hidden={immersive}>
          <label className="search">
            <Icon name="search" size={18} />
            <input
              type="search"
              placeholder="Strecken, Orte oder Regionen suchen …"
              value={search}
              onChange={(e) => {
                searchStore.set(e.target.value);
                if (page !== 'routes') setPage('routes');
              }}
            />
          </label>
          <div className="spacer" />
          <button className={`profile-chip${page === 'login' ? ' active' : ''}`} onClick={() => setPage(account.user ? 'settings' : 'login')} title={account.user ? 'Profil' : 'Anmelden'}>
            <span className="avatar">{name.trim().charAt(0).toUpperCase() || '?'}</span>
            <span className="profile-text">
              <strong>{account.user ? name : 'Anmelden'}</strong>
              <span className="level">
                Level {lvl.level}
                <span className="level-bar" title={`${Math.round(totalKm)} von ${lvl.nextKm} km bis Level ${lvl.level + 1}`}>
                  <span style={{ width: `${Math.round(lvl.progress * 100)}%` }} />
                </span>
              </span>
            </span>
          </button>
        </header>
        {ridePage && <RidePage view={page} />}
        {page === 'garage' && <GaragePage />}
        {page === 'activities' && <ActivitiesPage />}
        {page === 'devices' && <DevicesPage />}
        {page === 'settings' && <SettingsPage />}
        {page === 'login' && <LoginPage />}
      </div>
      <BluetoothChooser />
    </div>
  );
}
