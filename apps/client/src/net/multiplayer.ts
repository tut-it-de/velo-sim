import { Emitter } from '@velo/ble';
import { PROTOCOL_VERSION, type LoadoutDTO, type RiderInfo, type RideSummaryDTO, type ServerMessage } from '@velo/protocol';
import { Store } from '../state/store';
import { webSocketUrl } from './serverUrl';

interface Sample {
  t: number;
  d: number;
  v: number;
  lat: number;
  p: number;
  c: number;
}

export interface RemoteRider {
  info: RiderInfo;
  samples: Sample[];
}

export interface ChatLine {
  from: string;
  name: string;
  text: string;
  at: number;
}

export interface NetState {
  status: 'connecting' | 'online' | 'offline' | 'error';
  error?: string;
  authenticated: boolean;
  riderCount: number;
  chat: ChatLine[];
  lastRideOn?: { name: string; at: number };
}

type NetEvents = {
  joined: RiderInfo;
  left: string;
  [key: string]: unknown;
};

/** Render other riders this far in the past so there are always two samples to interpolate between. */
const INTERP_DELAY_MS = 250;

/**
 * WebSocket connection to the game server for one ride: sends my state at
 * 4 Hz, keeps a short sample buffer per remote rider and interpolates them.
 */
export class MultiplayerClient extends Emitter<NetEvents> {
  readonly state = new Store<NetState>({ status: 'connecting', authenticated: false, riderCount: 0, chat: [] });
  readonly riders = new Map<string, RemoteRider>();
  myId?: string;
  private ws?: WebSocket;
  private clockOffset = 0;
  private lastSent = 0;
  private summaryWaiter?: (s: RideSummaryDTO | undefined) => void;
  private closing = false;
  private attempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly serverUrl: string,
    private readonly hello: { name: string; country?: string; routeId: string; loadout: LoadoutDTO; weightKg: number; token?: string; simulated?: boolean },
  ) {
    super();
  }

  connect(): void {
    const url = webSocketUrl(this.serverUrl);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.patch({ status: 'error', error: String(err) });
      return;
    }
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION, ...this.hello }));
    ws.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        // ignore malformed
      }
    };
    ws.onerror = () => this.patch({ status: 'error', error: 'Verbindung zum Server fehlgeschlagen' });
    ws.onclose = (ev) => {
      for (const id of [...this.riders.keys()]) this.emit('left', id);
      this.riders.clear();
      this.myId = undefined;
      this.summaryWaiter?.(undefined);
      // Reconnect after network hiccups (not after bye or a protocol rejection).
      const rejected = ev.code >= 4000 && ev.code < 5000;
      if (!this.closing && !rejected && this.attempts < 6) {
        const delay = Math.min(15_000, 1000 * 2 ** this.attempts++);
        this.patch({ status: 'connecting', error: `Verbindung verloren – neuer Versuch in ${Math.round(delay / 1000)} s` });
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      } else if (this.state.get().status !== 'error') {
        this.patch({ status: 'offline' });
      }
    };
  }

  private patch(p: Partial<NetState>): void {
    this.state.set({ ...this.state.get(), ...p });
  }

  private onMessage(m: ServerMessage): void {
    switch (m.type) {
      case 'welcome':
        this.attempts = 0;
        this.myId = m.id;
        this.clockOffset = m.serverTime - Date.now();
        for (const info of m.riders) {
          this.riders.set(info.id, { info, samples: [] });
          this.emit('joined', info);
        }
        this.patch({ status: 'online', error: undefined, authenticated: m.authenticated, riderCount: this.riders.size + 1 });
        break;
      case 'joined':
        this.riders.set(m.rider.id, { info: m.rider, samples: [] });
        this.emit('joined', m.rider);
        this.patch({ riderCount: this.riders.size + 1 });
        break;
      case 'left':
        this.riders.delete(m.id);
        this.emit('left', m.id);
        this.patch({ riderCount: this.riders.size + 1 });
        break;
      case 'snapshot':
        for (const [id, d, v, lat, p, c] of m.r) {
          const r = this.riders.get(id);
          if (!r) continue;
          r.samples.push({ t: m.t, d, v, lat, p, c });
          if (r.samples.length > 12) r.samples.shift();
        }
        break;
      case 'chat':
        this.patch({ chat: [...this.state.get().chat.slice(-29), { from: m.from, name: m.name, text: m.text, at: m.at }] });
        break;
      case 'rideOn':
        if (m.to === this.myId) this.patch({ lastRideOn: { name: m.name, at: Date.now() } });
        break;
      case 'rideSummary':
        this.summaryWaiter?.(m.summary);
        this.summaryWaiter = undefined;
        break;
      case 'error':
        this.patch({ status: 'error', error: m.message });
        break;
    }
  }

  /** Called every physics tick; throttled to 4 Hz. */
  sendState(d: number, v: number, p: number, c: number, lat: number): void {
    const now = Date.now();
    if (now - this.lastSent < 250 || this.ws?.readyState !== WebSocket.OPEN || !this.myId) return;
    this.lastSent = now;
    this.ws.send(JSON.stringify({ type: 'state', d, v, p, c, lat }));
  }

  sendChat(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN && text.trim()) this.ws.send(JSON.stringify({ type: 'chat', text: text.trim().slice(0, 280) }));
  }

  sendRideOn(to: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'rideOn', to }));
  }

  /** Interpolated position of a remote rider (or extrapolated when samples are late). */
  position(id: string): Sample | undefined {
    const r = this.riders.get(id);
    if (!r || r.samples.length === 0) return undefined;
    const renderT = Date.now() + this.clockOffset - INTERP_DELAY_MS;
    const s = r.samples;
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1]!;
      const b = s[i]!;
      if (renderT >= a.t && renderT <= b.t) {
        const f = (renderT - a.t) / Math.max(1, b.t - a.t);
        return { t: renderT, d: a.d + (b.d - a.d) * f, v: a.v + (b.v - a.v) * f, lat: a.lat + (b.lat - a.lat) * f, p: b.p, c: b.c };
      }
    }
    const last = s[s.length - 1]!;
    const ahead = Math.min(1.5, Math.max(0, (renderT - last.t) / 1000));
    return { ...last, t: renderT, d: last.d + last.v * ahead };
  }

  /** Leaves the room and waits (briefly) for the server's ride booking. */
  async finish(timeoutMs = 4000): Promise<RideSummaryDTO | undefined> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return undefined;
    const result = new Promise<RideSummaryDTO | undefined>((resolve) => {
      this.summaryWaiter = resolve;
      setTimeout(() => resolve(undefined), timeoutMs);
    });
    this.closing = true;
    ws.send(JSON.stringify({ type: 'bye' }));
    const summary = await result;
    ws.close();
    return summary;
  }

  close(): void {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
