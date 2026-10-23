import { useEffect, useState } from 'react';
import type { GroupRideDTO, GroupStateDTO } from '@velo/protocol';
import { ROUTES, getTrack } from '@velo/routes';
import { accountStore } from '../net/api';
import { createGroupRide, fetchGroupRide, inviteLink, normalizeCode } from '../net/groups';
import type { MultiplayerClient } from '../net/multiplayer';
import type { AssistState, GroupAssist } from '../ride/groupAssist';
import type { RideSession } from '../ride/rideSession';
import { pageStore } from '../state/ui';
import { Store, useStore } from '../state/store';
import { Toggle } from './components';
import { Flag } from './Flag';
import './group.css';

const routeName = (id: string) => ROUTES.find((r) => r.id === id)?.name ?? id;

function formatStart(g: GroupRideDTO): string {
  if (g.status === 'riding') return 'läuft gerade';
  if (g.status === 'ended') return 'vorbei';
  if (g.startAt === null) return 'sobald der Gastgeber startet';
  return new Date(g.startAt).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' Uhr';
}

/** Value for <input type="datetime-local"> in local time. */
function localInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function CopyRow({ code }: { code: string }) {
  const link = inviteLink(code);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (navigator.share && /Mobi|iPad|iPhone|Android/i.test(navigator.userAgent)) await navigator.share({ title: 'Gruppenfahrt in Velo Sim', text: `Fahr mit! Code ${code}`, url: link });
      else {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      // share sheet closed / clipboard blocked – the code is on screen anyway
    }
  };
  return (
    <div className="group-invite">
      <span className="muted small">Code zum Einladen</span>
      <strong className="group-code">{code}</strong>
      <span className="group-link small" title={link}>
        {link}
      </span>
      <button onClick={() => void copy()}>{copied ? '✓ Kopiert' : 'Link teilen'}</button>
    </div>
  );
}

/** Create or join a group ride (from the ride page). */
export function GroupDialog({
  routeId,
  initialCode,
  onJoin,
  onClose,
}: {
  routeId: string | null;
  initialCode?: string;
  onJoin: (group: GroupRideDTO) => void;
  onClose: () => void;
}) {
  const account = useStore(accountStore);
  const [tab, setTab] = useState<'create' | 'join'>(initialCode ? 'join' : 'create');
  const [name, setName] = useState('');
  const [route, setRoute] = useState(routeId ?? ROUTES[0]!.id);
  const [later, setLater] = useState(false);
  const [startAt, setStartAt] = useState(() => localInput(Math.ceil((Date.now() + 30 * 60_000) / 900_000) * 900_000));
  const [together, setTogether] = useState(true);
  const [code, setCode] = useState(initialCode ?? '');
  const [found, setFound] = useState<GroupStateDTO | GroupRideDTO | null>(null);
  const [created, setCreated] = useState<GroupRideDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const lookup = (c: string) =>
    run(async () => {
      setFound(null);
      setFound(await fetchGroupRide(c));
    });
  useEffect(() => {
    if (initialCode && account.token) void lookup(initialCode);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const body = !account.token ? (
    <>
      <p className="muted">Gruppenfahrten gibt es nur angemeldet – so wissen alle, mit wem sie fahren.</p>
      <div className="row group-actions">
        <button onClick={onClose}>Abbrechen</button>
        <button className="primary" onClick={() => pageStore.set('login')}>
          Anmelden
        </button>
      </div>
    </>
  ) : created ? (
    <>
      <p>
        <strong>{created.name}</strong> auf {routeName(created.routeId)} – Start {formatStart(created)}.
      </p>
      <CopyRow code={created.id} />
      <div className="row group-actions">
        <button onClick={onClose}>Später</button>
        <button className="primary" onClick={() => onJoin(created)}>
          Zur Lobby
        </button>
      </div>
    </>
  ) : tab === 'create' ? (
    <form
      className="group-form"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const at = later ? new Date(startAt).getTime() : null;
          if (later && (!Number.isFinite(at) || at! < Date.now())) throw new Error('Bitte eine Startzeit in der Zukunft wählen');
          setCreated(await createGroupRide({ name: name.trim(), routeId: route, startAt: at, together }));
        });
      }}
    >
      <label>
        Name
        <input maxLength={40} placeholder={`Gruppenfahrt von ${account.user?.name ?? 'dir'}`} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Strecke
        <select value={route} onChange={(e) => setRoute(e.target.value)}>
          {ROUTES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} · {(getTrack(r.id).length / 1000).toFixed(1)} km
            </option>
          ))}
        </select>
      </label>
      <div className="group-start">
        <span>Start</span>
        <div className="segmented">
          <button type="button" className={!later ? 'active' : ''} onClick={() => setLater(false)}>
            Sofort
          </button>
          <button type="button" className={later ? 'active' : ''} onClick={() => setLater(true)}>
            Später
          </button>
        </div>
        {later ? (
          <input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} aria-label="Startzeit" />
        ) : (
          <span className="muted small">Du startest in der Lobby, wenn alle da sind.</span>
        )}
      </div>
      <Toggle
        checked={together}
        onChange={setTogether}
        label="Zusammenbleiben"
        hint="Kein Rennen: Wer zurückliegt, wird mitgezogen, wer vorne ist, etwas gebremst. Deine Watt, kJ und Taler bleiben echt."
      />
      <div className="row group-actions">
        <button type="button" onClick={onClose}>
          Abbrechen
        </button>
        <button className="primary" disabled={busy}>
          {busy ? 'Lege an …' : 'Gruppenfahrt anlegen'}
        </button>
      </div>
    </form>
  ) : (
    <form
      className="group-form"
      onSubmit={(e) => {
        e.preventDefault();
        void lookup(code);
      }}
    >
      <label>
        Code oder Einladungslink
        <input value={code} placeholder="z. B. K7QX2M" autoCapitalize="characters" onChange={(e) => setCode(e.target.value)} autoFocus />
      </label>
      {found && (
        <div className="group-found">
          <strong>{found.name}</strong>
          <span className="muted small">
            {routeName(found.routeId)} · Gastgeber {found.hostName} · Start {formatStart(found)}
            {found.together ? ' · Zusammenbleiben' : ''}
          </span>
          {'members' in found && found.members.length > 0 && <span className="small">{found.members.map((m) => m.name).join(', ')} schon da</span>}
        </div>
      )}
      <div className="row group-actions">
        <button type="button" onClick={onClose}>
          Abbrechen
        </button>
        {found && found.id === normalizeCode(code) && found.status !== 'ended' ? (
          <button type="button" className="primary" onClick={() => onJoin(found)}>
            Beitreten
          </button>
        ) : (
          <button className="primary" disabled={busy || normalizeCode(code).length < 6}>
            {busy ? 'Suche …' : 'Suchen'}
          </button>
        )}
      </div>
      {found?.status === 'ended' && <div className="error-text">Diese Gruppenfahrt ist schon vorbei.</div>}
    </form>
  );

  return (
    <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal group-dialog" role="dialog" aria-label="Gruppenfahrt">
        <h2>Gruppenfahrt</h2>
        {account.token && !created && (
          <div className="segmented group-tabs">
            <button className={tab === 'create' ? 'active' : ''} onClick={() => setTab('create')}>
              Anlegen
            </button>
            <button className={tab === 'join' ? 'active' : ''} onClick={() => setTab('join')}>
              Beitreten
            </button>
          </div>
        )}
        {body}
        {error && <div className="error-text">{error}</div>}
      </div>
    </div>
  );
}

/** Live group state for one ride: lobby list, countdown, start/end (fed by the room). */
export class GroupLink {
  readonly group: Store<GroupStateDTO>;
  /** True once the room has sent its own state (the HTTP copy may be outdated). */
  live = false;

  constructor(
    initial: GroupRideDTO,
    readonly net: MultiplayerClient,
    readonly assist?: GroupAssist,
  ) {
    this.group = new Store<GroupStateDTO>({ members: [], ...initial });
    net.on('group', (g) => {
      this.live = true;
      // the start distance only comes with the first message to a late rider
      this.group.set({ ...g, startD: g.startD ?? this.group.get().startD });
    });
    net.on('groupPos', (p) => assist?.update(p.d, p.v, p.n));
  }

  get isHost(): boolean {
    return accountStore.get().user?.id === this.group.get().hostUserId;
  }

  /** Without the host in the lobby, anyone may start. */
  get canStart(): boolean {
    const g = this.group.get();
    return this.isHost || !g.members.some((m) => m.host);
  }
}

function useNow(ms = 250): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Lobby over the 3D view until the common start. */
export function GroupLobby({ link, onLeave }: { link: GroupLink; onLeave: () => void }) {
  const g = useStore(link.group);
  const net = useStore(link.net.state);
  useNow();
  const left = g.startAt !== null ? Math.max(0, Math.ceil((g.startAt - link.net.serverNow()) / 1000)) : null;
  const myId = link.net.myId;
  return (
    <div className="group-lobby-backdrop">
      <div className="group-lobby hud-panel" role="dialog" aria-label="Lobby der Gruppenfahrt">
        <div className="group-lobby-head">
          <span className="muted small">Gruppenfahrt · {routeName(g.routeId)}</span>
          <h2>{g.name}</h2>
          {g.together && <span className="group-badge">Zusammenbleiben</span>}
        </div>
        {left !== null && left <= 60 ? (
          <div className="group-countdown" aria-live="polite">
            <span className="muted small">Start in</span>
            <strong>{left > 0 ? left : 'Los!'}</strong>
          </div>
        ) : (
          <div className="group-waiting muted">
            {net.status !== 'online' ? (net.error ?? 'Verbinde …') : left !== null ? `Start ${formatStart(g)}` : link.isHost ? 'Starte, wenn alle da sind.' : `Wartet auf den Start durch ${g.hostName}.`}
          </div>
        )}
        <div className="group-members">
          <span className="hud-label">Dabei ({g.members.length})</span>
          {g.members.map((m) => (
            <div key={m.id} className={`group-member${m.id === myId ? ' me' : ''}`}>
              <Flag code={m.country} size={18} />
              <span>{m.name}</span>
              {m.host && <span className="muted small">Gastgeber</span>}
              {m.id === myId && <span className="muted small">du</span>}
            </div>
          ))}
        </div>
        <CopyRow code={g.id} />
        <div className="row group-actions">
          <button onClick={onLeave}>Verlassen</button>
          {link.canStart && (left === null || left > 10) && (
            <button className="primary" disabled={net.status !== 'online'} onClick={() => link.net.sendGroup('groupStart')}>
              Jetzt starten
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const HINT: Record<'pull' | 'brake' | 'hold', string> = {
  pull: 'Gruppe zieht dich mit',
  brake: 'Du bist vorne – die Gruppe bremst dich etwas',
  hold: '',
};

/** Group panel in the HUD: name, riders with their gap, the pull/brake hint, end for everyone. */
export function GroupHud({ link, session, onEndAll }: { link: GroupLink; session: RideSession; onEndAll: () => void }) {
  const g = useStore(link.group);
  const s = useStore(session.snapshot);
  const assist = useStore(link.assist?.state ?? EMPTY_ASSIST);
  const [confirm, setConfirm] = useState(false);
  const riders = s.others.filter((o) => o.remote).sort((a, b) => b.gapM - a.gapM);
  const hint =
    assist.mode === 'hold'
      ? (assist.gapM ?? 0) > 0
        ? 'Abgehängt – die Gruppe holt dich zurück'
        : 'Zu weit vorne – warte auf die Gruppe'
      : assist.mode !== 'none'
        ? HINT[assist.mode]
        : null;
  return (
    <div className="group-hud">
      <div className="hud-panel group-hud-panel">
        <div className="group-hud-head">
          <span className="group-hud-name">👥 {g.name}</span>
          <span className="muted small">{g.members.length} Fahrer</span>
        </div>
        {riders.slice(0, 6).map((r) => (
          <div key={r.id} className="group-hud-row">
            <Flag code={r.country} size={16} />
            <span className="group-hud-rider">{r.name}</span>
            <span className={r.gapM >= 0 ? 'gap ahead' : 'gap behind'}>
              {Math.abs(r.gapM) < 1 ? 'neben dir' : `${r.gapM > 0 ? '+' : '−'}${Math.round(Math.abs(r.gapM))} m`}
            </span>
          </div>
        ))}
        {riders.length === 0 && <div className="muted small">Noch niemand sonst auf der Strecke</div>}
        {link.isHost && g.status === 'riding' && (
          <div className="group-hud-end">
            {confirm ? (
              <>
                <span className="small">Für alle beenden?</span>
                <button onClick={() => setConfirm(false)}>Nein</button>
                <button className="danger" onClick={onEndAll}>
                  Ja
                </button>
              </>
            ) : (
              <button onClick={() => setConfirm(true)}>Fahrt für alle beenden</button>
            )}
          </div>
        )}
      </div>
      {hint && <div className={`group-hint ${assist.mode}`}>{hint}</div>}
    </div>
  );
}

const EMPTY_ASSIST = new Store<AssistState>({ mode: 'none', riders: 0 });
