import { useState, type FormEvent } from 'react';
import { accountStore, fetchOnline, login, logout, register, serverBase } from '../net/api';
import { builtInServer } from '../net/serverUrl';
import { settingsStore, updateSettings } from '../state/settings';
import { useStore } from '../state/store';
import { pageStore } from '../state/ui';

/**
 * Suggested server address: the one built into the app (VITE_SERVER_URL, set by npm run ios:sync), or where
 * `npm run server` listens when the client runs from the Vite dev server or `vite preview`.
 */
const devServer = () => builtInServer || (typeof location !== 'undefined' ? `http://${location.hostname}:8080` : '');

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
  const [editServer, setEditServer] = useState(!serverBase());
  const [server, setServer] = useState(settings.serverUrl || devServer());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editServer) {
        updateSettings({ serverUrl: server.trim() });
        if (!(await fetchOnline())) throw new Error(`Unter ${server.trim() || 'dieser Adresse'} antwortet kein Server.`);
      }
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
            Du bist als <strong>{account.user.name}</strong> ({account.user.email}) auf {serverBase()} angemeldet.
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
  const ready = !!email.trim() && password.length >= (register_ ? 8 : 1) && (!register_ || name.trim().length >= 2) && (!editServer || !!server.trim());

  return (
    <div className="page">
      <div className="page-inner auth">
        <h1>{register_ ? 'Konto erstellen' : 'Anmelden'}</h1>
        <p className="muted">
          Mit Konto fährst du mit anderen auf derselben Strecke, siehst ihre Namen und sie deinen. Taler und Garage liegen dann auf dem Server und
          gehen nicht verloren.
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
          {editServer ? (
            <label>
              Server
              <input value={server} placeholder="https://velo.example.de" onChange={(e) => setServer(e.target.value)} />
            </label>
          ) : (
            <div className="small muted">
              Server: {serverBase()}{' '}
              <button type="button" className="link" onClick={() => setEditServer(true)}>
                ändern
              </button>
            </div>
          )}
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
