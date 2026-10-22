import { useState, type FormEvent } from 'react';
import { accountStore, login, logout, register } from '../net/api';
import { settingsStore, updateSettings } from '../state/settings';
import { useStore } from '../state/store';
import { pageStore } from '../state/ui';

/**
 * Sign in or create an account on the game server. With an account the server books the Taler
 * from the ride data, keeps the garage and shows your name to the other riders on the route.
 */
export function LoginPage() {
  const account = useStore(accountStore);
  const settings = useStore(settingsStore);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [name, setName] = useState(settings.riderName === 'Fahrer' ? '' : settings.riderName);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(email.trim(), password);
      else await register(email.trim(), name.trim(), password);
      updateSettings({ rideOnline: true });
      pageStore.set('ride');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (account.user) {
    return (
      <div className="page">
        <div className="page-inner auth">
          <h1>Angemeldet</h1>
          <p>
            Du bist als <strong>{account.user.name}</strong> ({account.user.email}) angemeldet.
          </p>
          <div className="row">
            <button className="primary" onClick={() => pageStore.set('ride')}>
              Zur Streckenwahl
            </button>
            <button onClick={() => logout()}>Abmelden</button>
          </div>
        </div>
      </div>
    );
  }

  const register_ = mode === 'register';
  const ready = !!email.trim() && password.length >= (register_ ? 8 : 1) && (!register_ || name.trim().length >= 2);

  return (
    <div className="page">
      <div className="page-inner auth">
        <div className="auth-brand">
          <span className="brand-mark">V</span>
          <span className="brand-name">Velo Sim</span>
        </div>
        <h1>{register_ ? 'Konto erstellen' : 'Anmelden'}</h1>
        <p className="muted">
          Zum Fahren brauchst du ein Konto. Einmal angemeldet, fährst du auch ohne Internet – Strava-Uploads holt die App nach, sobald du wieder
          online bist.
        </p>
        <form className="auth-form" onSubmit={submit}>
          <label>
            E-Mail
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </label>
          {register_ && (
            <label>
              Name auf der Strecke
              <input autoComplete="nickname" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          <label>
            Passwort{register_ && <span className="muted"> (mindestens 8 Zeichen)</span>}
            <input type="password" autoComplete={register_ ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button className="primary" type="submit" disabled={busy || !ready}>
            {busy ? 'Einen Moment …' : register_ ? 'Konto erstellen' : 'Anmelden'}
          </button>
        </form>
        <p className="small">
          {register_ ? 'Schon ein Konto? ' : 'Noch kein Konto? '}
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(register_ ? 'login' : 'register');
              setError(null);
            }}
          >
            {register_ ? 'Anmelden' : 'Registrieren'}
          </button>
        </p>
      </div>
    </div>
  );
}
