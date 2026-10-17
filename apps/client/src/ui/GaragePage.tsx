import { useMemo, useState } from 'react';
import {
  CATALOG,
  CATEGORY_LABEL,
  CUT_LABEL,
  TIER_LABEL,
  aeroStars,
  compareLoadouts,
  estimateTime,
  formatCoins,
  itemName,
  resolveLoadout,
  setupFor,
  weightStars,
  type EquipmentItem,
  type ItemType,
} from '@velo/equipment';
import { totalMass } from '@velo/physics';
import { ROUTES, getTrack } from '@velo/routes';
import { balance, buy, equip, garageStore } from '../state/garage';
import { accountStore, isLoggedIn, serverBuy, serverEquip } from '../net/api';
import { settingsStore } from '../state/settings';
import { useStore } from '../state/store';
import { formatDuration } from './components';
import { AvatarPreview } from './AvatarPreview';
import { lookFromLoadout } from '../game/look';

const TABS: Array<{ id: ItemType; label: string }> = [
  { id: 'bike', label: 'Räder' },
  { id: 'wheels', label: 'Laufräder' },
  { id: 'jersey', label: 'Trikots' },
];

function Rating({ label, value }: { label: string; value?: number }) {
  if (value === undefined) return null;
  return (
    <div className="rating">
      <span>{label}</span>
      <div className="rating-bar">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="rating-seg">
            <div style={{ width: `${Math.min(1, Math.max(0, value - (i - 1))) * 100}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Swatch({ item }: { item: EquipmentItem }) {
  const colors =
    item.type === 'bike' ? [item.look.frame, item.look.accent] : item.type === 'wheels' ? [item.look.rim, '#141414'] : [item.look.jersey, item.look.accent];
  return (
    <div className="swatch">
      {colors.map((c, i) => (
        <span key={i} style={{ background: c }} />
      ))}
    </div>
  );
}

function signedTime(s: number): string {
  if (Math.abs(s) < 0.5) return '±0:00';
  return `${s < 0 ? '−' : '+'}${formatDuration(Math.abs(s))}`;
}

export function GaragePage() {
  const garage = useStore(garageStore);
  const account = useStore(accountStore);
  const settings = useStore(settingsStore);
  const [tab, setTab] = useState<ItemType>('bike');
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const coins = balance(garage);
  const power = Math.round(settings.ftp * 0.75);
  const tracks = useMemo(() => ROUTES.map((r) => getTrack(r.id)), []);
  const current = resolveLoadout(garage.loadout);
  const setup = setupFor(settings, garage.loadout);

  const lapTimes = useMemo(
    () => tracks.map((t) => ({ id: t.id, name: t.name, s: estimateTime(t, setupFor(settings, garage.loadout), power) })),
    [tracks, settings, garage.loadout, power],
  );

  const selectedItem = selected ? CATALOG.find((i) => i.id === selected) : undefined;
  const comparison = useMemo(() => {
    if (!selectedItem || garage.loadout[selectedItem.type] === selectedItem.id) return null;
    return compareLoadouts(tracks, settings, garage.loadout, { ...garage.loadout, [selectedItem.type]: selectedItem.id }, power);
  }, [selectedItem, garage.loadout, tracks, settings, power]);

  const items = CATALOG.filter((i) => i.type === tab).sort((a, b) => a.price - b.price);
  // The preview shows the selected item on the current setup.
  const previewLook = useMemo(
    () => lookFromLoadout(selectedItem ? { ...garage.loadout, [selectedItem.type]: selectedItem.id } : garage.loadout),
    [garage.loadout, selectedItem],
  );

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <div className="eyebrow">Ausrüstung</div>
            <h1>Garage</h1>
          </div>
          <div className="row">
            <span className="muted small">{account.user ? `Konto: ${account.user.name} (Server)` : 'lokal – unter Profil mit einem Server verbinden'}</span>
            <div className="wallet-chip wallet-big"><span className="coin" />{formatCoins(coins)} Watt-Taler</div>
          </div>
        </div>

        <div className="card garage-current">
          <AvatarPreview look={previewLook} />
          <div>
            <div className="muted small">Aktuelle Ausrüstung</div>
            <div className="garage-loadout">
              <span>🚲 {itemName(current.bike)}</span>
              <span>◎ {itemName(current.wheels)}</span>
              <span>👕 {itemName(current.jersey)}</span>
            </div>
            <div className="muted small">
              CdA {setup.cda.toFixed(3)} m² · Rad + Laufräder {(setup.bikeMassKg + setup.wheelsMassKg).toFixed(1)} kg · Gesamt {totalMass(setup).toFixed(1)} kg
            </div>
          </div>
          <div className="garage-times">
            {lapTimes.map((t) => (
              <div key={t.id} className="stat">
                <span className="stat-label">{t.name}</span>
                <span className="stat-value">{formatDuration(t.s)}</span>
              </div>
            ))}
            <div className="muted small garage-times-note">
              geschätzte Rundenzeit bei {power} W (75 % FTP)
            </div>
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="segmented">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          {message && <span className="small">{message}</span>}
        </div>

        {comparison && selectedItem && (
          <div className="card comparison">
            <strong>{itemName(selectedItem)}</strong> statt {itemName(current[selectedItem.type])}:
            {comparison.map((c) => (
              <span key={c.trackId} className={c.deltaS < -0.5 ? 'faster' : c.deltaS > 0.5 ? 'slower' : ''}>
                {c.trackName} {signedTime(c.deltaS)}
              </span>
            ))}
          </div>
        )}

        <div className="item-grid">
          {items.map((item) => {
            const owned = garage.owned.includes(item.id);
            const equipped = garage.loadout[item.type] === item.id;
            const affordable = coins >= item.price;
            const sub =
              item.type === 'bike'
                ? `${CATEGORY_LABEL[item.category]} · ${item.weightKg.toFixed(1)} kg`
                : item.type === 'wheels'
                  ? `${item.rimDepthMm} mm Felge · ${item.weightKg.toFixed(2)} kg`
                  : CUT_LABEL[item.cut];
            return (
              <div
                key={item.id}
                className={`item-card ${selected === item.id ? 'selected' : ''} ${equipped ? 'equipped' : ''}`}
                onClick={() => setSelected(item.id)}
                role="button"
              >
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <Swatch item={item} />
                  <span className={`badge tier-${item.tier}`}>{TIER_LABEL[item.tier]}</span>
                </div>
                <strong>{itemName(item)}</strong>
                <div className="muted small">{sub}</div>
                <Rating label="Aero" value={aeroStars(item)} />
                <Rating label="Gewicht" value={weightStars(item)} />
                <div className="muted small">
                  ΔCdA {item.cdaDelta > 0 ? '+' : item.cdaDelta < 0 ? '−' : '±'}
                  {Math.abs(item.cdaDelta).toFixed(3).replace('.', ',')} m²
                  {item.inspiredBy && <> · angelehnt an {item.inspiredBy}</>}
                </div>
                <div className="item-action" onClick={(e) => e.stopPropagation()}>
                  {equipped ? (
                    <span className="equipped-label">✓ Ausgerüstet</span>
                  ) : owned ? (
                    <button
                      onClick={async () => {
                        try {
                          if (isLoggedIn()) await serverEquip(item.id);
                          else equip(item.id);
                          setMessage(`${itemName(item)} ausgerüstet`);
                        } catch (err) {
                          setMessage(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      Ausrüsten
                    </button>
                  ) : (
                    <button
                      className="primary"
                      disabled={!affordable}
                      title={affordable ? '' : `Noch ${formatCoins(item.price - coins)} Taler`}
                      onClick={async () => {
                        try {
                          if (isLoggedIn()) {
                            await serverBuy(item.id);
                            await serverEquip(item.id);
                          } else {
                            const res = buy(item.id);
                            if (!res.ok) throw new Error(res.error);
                            equip(item.id);
                          }
                          setMessage(`${itemName(item)} gekauft und ausgerüstet`);
                        } catch (err) {
                          setMessage(err instanceof Error ? err.message : String(err));
                        }
                      }}
                    >
                      🪙 {formatCoins(item.price)}
                    </button>
                  )}
                  {!owned && !affordable && <span className="muted small">noch {formatCoins(item.price - coins)}</span>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="card">
          <h2>Kontobewegungen</h2>
          {garage.ledger.length === 0 && <div className="muted small">Noch keine. Fahre mit deinem Trainer – pro kJ gibt es einen Watt-Taler, dazu Boni für Runden, Bestzeiten und Workouts.</div>}
          <table className="segments-table">
            <tbody>
              {[...garage.ledger]
                .reverse()
                .slice(0, 15)
                .map((e) => (
                  <tr key={e.id}>
                    <td className="muted small">{new Date(e.at).toLocaleDateString('de-DE')}</td>
                    <td>{e.label}</td>
                    <td style={{ textAlign: 'right', color: e.amount >= 0 ? 'var(--ok)' : 'var(--text)' }}>
                      {e.amount >= 0 ? '+' : '−'}
                      {formatCoins(Math.abs(e.amount))}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
