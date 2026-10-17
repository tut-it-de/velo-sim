import { useEffect, useState } from 'react';
import { connectStrava, disconnectStrava, refreshStravaStatus, setStravaAutoUpload, stravaStore } from '../net/strava';
import { accountStore, fetchOnline, login, logout, refreshAccount, register } from '../net/api';
import { GRAPHICS_QUALITY_OPTIONS } from '../game/real/quality';
import { settingsStore, updateSettings, type Settings } from '../state/settings';
import { useStore } from '../state/store';
import { COUNTRIES, Flag } from './Flag';
import { Toggle } from './components';

function NumberField({ k, min, max, step = 1 }: { k: keyof Settings; min: number; max: number; step?: number }) {
  const settings = useStore(settingsStore);
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={settings[k] as number}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) updateSettings({ [k]: Math.min(max, Math.max(min, v)) } as Partial<Settings>);
      }}
      style={{ width: 120 }}
    />
  );
}

export function SettingsPage() {
  const s = useStore(settingsStore);
  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1>Profil & Einstellungen</h1>
          </div>
        </div>
        <div className="card">
          <h2>Fahrer</h2>
          <div className="form">
            <label>Name</label>
            <input value={s.riderName} maxLength={24} onChange={(e) => updateSettings({ riderName: e.target.value })} style={{ maxWidth: 260 }} />
            <label>Land</label>
            <div className="row">
              <select value={s.country} onChange={(e) => updateSettings({ country: e.target.value })} style={{ maxWidth: 260 }}>
                {COUNTRIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Flag code={s.country} size={24} />
            </div>
            <label>Gewicht (kg)</label>
            <NumberField k="weightKg" min={35} max={160} step={0.5} />
            <label>Größe (cm)</label>
            <NumberField k="heightCm" min={130} max={215} />
            <label>FTP (W)</label>
            <div className="row">
              <NumberField k="ftp" min={50} max={600} />
              <span className="muted small">{(s.ftp / s.weightKg).toFixed(2)} W/kg – Grundlage für alle Workouts</span>
            </div>
          </div>
        </div>
        <AccountCard />
        <StravaCard />
        <div className="card">
          <h2>Trainer</h2>
          <div className="form">
            <label>Trainer-Schwierigkeit</label>
            <div className="row">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={s.trainerDifficulty}
                onChange={(e) => updateSettings({ trainerDifficulty: Number(e.target.value) })}
                style={{ width: 220 }}
              />
              <span>{Math.round(s.trainerDifficulty * 100)} %</span>
              <span className="muted small">
                {s.trainerDifficulty === 0 ? 'flach – Steigungen nur optisch' : `8 % Steigung fühlen sich wie ${(8 * s.trainerDifficulty).toFixed(1)} % an`}
              </span>
            </div>
            <label>Kadenzquelle</label>
            <label className="row" style={{ color: 'var(--text)' }}>
              <input type="checkbox" checked={s.preferCadenceSensor} onChange={(e) => updateSettings({ preferCadenceSensor: e.target.checked })} />
              Kadenzsensor bevorzugen, wenn verbunden
            </label>
          </div>
        </div>
        <div className="card">
          <h2>Grafik</h2>
          <div className="form">
            <label>Qualität</label>
            <div>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                {GRAPHICS_QUALITY_OPTIONS.map((o) => (
                  <button key={o.id} className={s.graphicsQuality === o.id ? 'primary' : ''} onClick={() => updateSettings({ graphicsQuality: o.id })}>
                    {o.label}
                  </button>
                ))}
              </div>
              <div className="muted small" style={{ marginTop: 6 }}>
                {GRAPHICS_QUALITY_OPTIONS.find((o) => o.id === s.graphicsQuality)?.hint} · gilt ab der nächsten Fahrt
              </div>
            </div>
          </div>
        </div>
        <div className="card admin-card">
          <h2>Admin</h2>
          <Toggle
            checked={s.adminMode}
            onChange={(v) => updateSettings({ adminMode: v })}
            label="Admin-Modus"
            hint={
              <>
                In der Fahrt erscheint „Teleport“ (Taste <kbd>T</kbd>): Punkt auf Karte oder Höhenprofil anklicken und dorthin springen.
                Fahrten mit Teleport zählen nicht für Taler und Bestzeiten.
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}

function AccountCard() {
  const settings = useStore(settingsStore);
  const account = useStore(accountStore);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState(settings.riderName);
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
      setStatus(ok);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Online & Konto</h2>
      <div className="form">
        <label>Server</label>
        <div className="row">
          <input
            value={settings.serverUrl}
            placeholder="z. B. https://velo.deine-domain.de oder http://localhost:8080"
            onChange={(e) => updateSettings({ serverUrl: e.target.value.trim() })}
            style={{ width: 380 }}
          />
          <button
            disabled={!settings.serverUrl}
            onClick={() => run(async () => {
              const o = await fetchOnline();
              if (!o) throw new Error('Server nicht erreichbar');
            }, 'Server erreichbar ✓')}
          >
            Testen
          </button>
        </div>
        {account.user ? (
          <>
            <label>Angemeldet</label>
            <div className="row">
              <strong>{account.user.name}</strong>
              <span className="muted small">{account.user.email}</span>
              <button onClick={() => run(refreshAccount, 'Garage synchronisiert ✓')} disabled={busy}>
                Synchronisieren
              </button>
              <button onClick={() => logout()}>Abmelden</button>
            </div>
          </>
        ) : (
          <>
            <label>{mode === 'login' ? 'Anmelden' : 'Registrieren'}</label>
            <div className="row">
              <input type="email" placeholder="E-Mail" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: 200 }} />
              {mode === 'register' && <input placeholder="Name" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} style={{ width: 140 }} />}
              <input type="password" placeholder="Passwort (min. 8)" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: 170 }} />
              <button
                className="primary"
                disabled={busy || !settings.serverUrl || !email || password.length < (mode === 'register' ? 8 : 1)}
                onClick={() =>
                  run(
                    () => (mode === 'login' ? login(email, password) : register(email, name, password)),
                    mode === 'login' ? 'Angemeldet ✓' : 'Konto erstellt ✓',
                  )
                }
              >
                {mode === 'login' ? 'Anmelden' : 'Konto erstellen'}
              </button>
              <button className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
                {mode === 'login' ? 'Neu hier? Registrieren' : 'Schon ein Konto? Anmelden'}
              </button>
            </div>
          </>
        )}
      </div>
      {status && <div className="small" style={{ marginTop: 8 }}>{status}</div>}
      <p className="muted small" style={{ marginBottom: 0 }}>
        Ohne Server fährst du offline, Garage und Taler liegen dann nur auf diesem Gerät. Mit Konto bucht der Server die Taler aus deinen Leistungsdaten,
        und du siehst andere Fahrer auf der Strecke.
      </p>
    </div>
  );
}

function StravaCard() {
  const account = useStore(accountStore);
  const strava = useStore(stravaStore);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void refreshStravaStatus();
  }, [account.token]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>
        <span className="strava-mark">Strava</span>
      </h2>
      {!account.user ? (
        <div className="muted small">Melde dich oben mit deinem Server-Konto an – der Strava-Upload läuft über den Server.</div>
      ) : !strava.configured ? (
        <div className="muted small">
          Auf deinem Server ist Strava noch nicht eingerichtet (STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET und PUBLIC_URL setzen – siehe README).
        </div>
      ) : strava.connected ? (
        <div className="form">
          <label>Verbunden</label>
          <div className="row">
            <strong>{strava.athleteName}</strong>
            <button disabled={busy} onClick={() => run(disconnectStrava)}>
              Trennen
            </button>
          </div>
          <label>Automatisch hochladen</label>
          <label className="row" style={{ color: 'var(--text)' }}>
            <input type="checkbox" checked={!!strava.autoUpload} disabled={busy} onChange={(e) => run(() => setStravaAutoUpload(e.target.checked))} />
            Jede Fahrt ab 1 Minute nach dem Beenden zu Strava hochladen (Simulator-Fahrten nie)
          </label>
        </div>
      ) : (
        <div className="row">
          <button
            className="strava-button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                setMessage('Bitte im Browser bei Strava anmelden und „Autorisieren“ tippen …');
                const ok = await connectStrava();
                setMessage(ok ? 'Strava verbunden ✓' : 'Keine Bestätigung von Strava erhalten – bitte erneut versuchen.');
              })
            }
          >
            Mit Strava verbinden
          </button>
          <span className="muted small">Fahrten landen als „Virtual Ride“ mit Leistung, Kadenz und Herzfrequenz in deinem Strava-Profil.</span>
        </div>
      )}
      {message && <div className="small" style={{ marginTop: 8 }}>{message}</div>}
    </div>
  );
}
