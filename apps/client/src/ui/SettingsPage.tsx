import { useState } from 'react';
import { accountStore, fetchOnline, login, logout, refreshAccount, register } from '../net/api';
import { settingsStore, updateSettings, type Settings } from '../state/settings';
import { useStore } from '../state/store';

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
        <h1>Profil & Einstellungen</h1>
        <div className="card">
          <h2>Fahrer</h2>
          <div className="form">
            <label>Name</label>
            <input value={s.riderName} maxLength={24} onChange={(e) => updateSettings({ riderName: e.target.value })} style={{ maxWidth: 260 }} />
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
