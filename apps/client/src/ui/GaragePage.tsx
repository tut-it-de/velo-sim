import { useMemo, useState } from 'react';
import { CATALOG, CATEGORY_LABEL, CUT_LABEL, HELMET_LABEL, TIER_LABEL, formatCoins, itemName, resolveLoadout, type EquipmentItem, type ItemType } from '@velo/equipment';
import { balance, buy, equip, garageStore } from '../state/garage';
import { isLoggedIn, serverBuy, serverEquip } from '../net/api';
import { settingsStore } from '../state/settings';
import { useStore } from '../state/store';
import { AvatarPreview } from './AvatarPreview';
import { useItemThumb } from './itemThumbs';
import { lookFromLoadout } from '../game/look';

const TABS: Array<{ id: ItemType; label: string }> = [
  { id: 'bike', label: 'Räder' },
  { id: 'wheels', label: 'Laufräder' },
  { id: 'jersey', label: 'Trikots' },
  { id: 'helmet', label: 'Helme' },
];

function Swatch({ item }: { item: EquipmentItem }) {
  const colors =
    item.type === 'bike'
      ? [item.look.frame, item.look.accent]
      : item.type === 'wheels'
        ? [item.look.rim, '#141414']
        : item.type === 'helmet'
          ? [item.look.shell, item.look.accent]
          : [item.look.jersey, item.look.accent];
  return (
    <div className="swatch">
      {colors.map((c, i) => (
        <span key={i} style={{ background: c }} />
      ))}
    </div>
  );
}

/** The rendered item, the colours until the picture is ready. */
function ItemImage({ item }: { item: EquipmentItem }) {
  const url = useItemThumb(item);
  return (
    <div className="item-img">
      {url ? <img src={url} alt="" /> : <Swatch item={item} />}
      <span className={`badge tier-${item.tier}`}>{TIER_LABEL[item.tier]}</span>
    </div>
  );
}

export function GaragePage() {
  const garage = useStore(garageStore);
  const settings = useStore(settingsStore);
  const [tab, setTab] = useState<ItemType>('bike');
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const coins = balance(garage);
  const current = resolveLoadout(garage.loadout);
  const selectedItem = selected ? CATALOG.find((i) => i.id === selected) : undefined;

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
            <h1>Garage</h1>
          </div>
        </div>

        <div className="card garage-current">
          <AvatarPreview look={previewLook} />
          <div>
            <div className="muted small">Aktuelle Ausrüstung</div>
            <div className="garage-loadout">
              <span>{itemName(current.bike)}</span>
              <span>{itemName(current.wheels)}</span>
              <span>{itemName(current.jersey)}</span>
              <span>{itemName(current.helmet)}</span>
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

        <div className="item-grid">
          {items.map((item) => {
            const owned = item.price === 0 || garage.owned.includes(item.id);
            const equipped = garage.loadout[item.type] === item.id;
            const affordable = coins >= item.price;
            const sub =
              item.type === 'bike'
                ? CATEGORY_LABEL[item.category]
                : item.type === 'wheels'
                  ? `${item.rimDepthMm} mm Felge`
                  : item.type === 'helmet'
                    ? HELMET_LABEL[item.look.shape]
                    : CUT_LABEL[item.cut];
            return (
              <div
                key={item.id}
                className={`item-card ${selected === item.id ? 'selected' : ''} ${equipped ? 'equipped' : ''}`}
                onClick={() => setSelected(item.id)}
                role="button"
              >
                <ItemImage item={item} />
                <strong>{itemName(item)}</strong>
                <div className="muted small">
                  {sub}
                  {item.inspiredBy && <> · angelehnt an {item.inspiredBy}</>}
                </div>
                <div className="item-action" onClick={(e) => e.stopPropagation()}>
                  {equipped ? (
                    <span className="equipped-label">Ausgerüstet</span>
                  ) : owned ? (
                    <button
                      onClick={async () => {
                        try {
                          if (isLoggedIn() && !settings.adminMode) await serverEquip(item.id);
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
                          if (isLoggedIn() && !settings.adminMode) {
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
                      {settings.adminMode ? 'Gratis holen' : `Kaufen · ${formatCoins(item.price)}`}
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
