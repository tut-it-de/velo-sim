import { useEffect } from 'react';
import { ftpStore, skipLevelQuestion } from '../ftp/ftpStore';
import { FtpSetupDialog } from './FtpUi';
import { settingsStore } from '../state/settings';
import { accountStore, isAdminUser, refreshAccount } from '../net/api';
import { deviceManager } from '../devices/deviceManager';
import { refreshStravaStatus, syncPendingStrava } from '../net/strava';
import { activitiesStore, loadActivities } from '../state/activities';
import { syncActivitiesQuietly } from '../net/activitySync';
import { useStore } from '../state/store';
import { pageStore, uiStore, type Page } from '../state/ui';
import { AchievementsPage } from './AchievementsPage';
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
import { ShiftingPage } from './ShiftingPage';
import { useSimulatorKeys } from './useSimulatorKeys';

const PAGES: Array<{ id: Exclude<Page, 'login'>; label: string; icon: IconName }> = [
  { id: 'ride', label: 'Fahren', icon: 'routes' },
  { id: 'workouts', label: 'Workouts', icon: 'workouts' },
  { id: 'activities', label: 'Aktivitäten', icon: 'activities' },
  { id: 'achievements', label: 'Erfolge', icon: 'trophy' },
  { id: 'garage', label: 'Garage', icon: 'garage' },
  { id: 'devices', label: 'Geräte', icon: 'devices' },
  { id: 'shifting', label: 'Virtuelle Schaltung', icon: 'shift' },
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
  const activities = useStore(activitiesStore);
  const ftpState = useStore(ftpStore);
  useSimulatorKeys();

  useEffect(() => {
    // Sync wallet/garage and Strava link from the server when logged in.
    void Promise.all([refreshAccount().catch(() => undefined), loadActivities()])
      .then(() => syncActivitiesQuietly())
      .then(() => refreshStravaStatus())
      .then(() => syncPendingStrava());
    // iPad app: find the trainer and the strap without a chooser.
    void deviceManager.autoConnect();
  }, []);

  // The trainer simulator is for admins only.
  const admin = isAdminUser(account);
  useEffect(() => {
    if (!admin && settings.useSimulator) void deviceManager.setSimulator(false);
  }, [admin, settings.useSimulator]);

  const name = account.user?.name ?? settings.riderName;
  const totalKm = activities.reduce((km, a) => km + a.summary.distanceM / 1000, 0);
  const lvl = riderLevel(totalKm);
  const ridePage = page === 'ride' || page === 'workouts';

  // An account is required. Once signed in, the app stays signed in and also works offline.
  if (!account.user) {
    return (
      <div className="app auth-gate">
        <LoginPage />
      </div>
    );
  }

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
      </aside>

      <div className="main">
        <header className="topbar" hidden={immersive}>
          <div className="spacer" />
          <button className="wallet-chip" onClick={() => setPage('garage')} title="Watt-Taler – zur Garage">
            <span className="coin" aria-hidden>W</span>
            <strong>{settings.adminMode ? '∞' : formatCoins(balance(garage))}</strong>
            <span className="muted small">Watt-Taler</span>
          </button>
          <button className={`profile-chip${page === 'settings' ? ' active' : ''}`} onClick={() => setPage('settings')} title="Profil">
            <span className="avatar">{name.trim().charAt(0).toUpperCase() || '?'}</span>
            <span className="profile-text">
              <strong>{name}</strong>
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
        {page === 'achievements' && <AchievementsPage />}
        {page === 'devices' && <DevicesPage />}
        {page === 'shifting' && <ShiftingPage />}
        {page === 'settings' && <SettingsPage />}
        {page === 'login' && <LoginPage />}
      </div>
      <BluetoothChooser />
      {/* First start without an FTP: ask once how fit the rider is (can be skipped). */}
      {!immersive && settings.ftp <= 0 && !ftpState.levelAsked && <FtpSetupDialog onDone={() => undefined} onClose={skipLevelQuestion} />}
    </div>
  );
}
