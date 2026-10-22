import { useEffect, useState } from 'react';
import { deviceManager } from '../devices/deviceManager';
import { GEARS, NEUTRAL_GEAR } from '../ride/rideSession';
import { settingsStore, updateSettings } from '../state/settings';
import { useStore } from '../state/store';
import { StatusDot, Toggle } from './components';

/**
 * Virtual shifting: how to change the 24 virtual gears – a Zwift remote (Click, Play, Ride),
 * the mouse or the keyboard. The test field shows each shift right away.
 */
export function ShiftingPage() {
  const settings = useStore(settingsStore);
  const shifter = useStore(deviceManager.shifterSlot);
  const [gear, setGear] = useState(NEUTRAL_GEAR);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const connected = shifter.state === 'connected' || shifter.state === 'reconnecting';
  const busy = shifter.state === 'connecting';

  const shift = (d: 1 | -1) => {
    setGear((g) => Math.min(GEARS.length, Math.max(1, g + d)));
    setFlash(d > 0 ? 'up' : 'down');
  };

  useEffect(() => deviceManager.onShift(shift), []);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 250);
    return () => clearTimeout(t);
  }, [flash, gear]);
  useEffect(() => {
    if (!settings.shiftKeys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') shift(1);
      else if (e.key === '-' || e.key === '_') shift(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settings.shiftKeys]);

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1>Virtuelle Schaltung</h1>
            <span className="muted">
              24 Gänge wie bei Zwift: Der Trainer macht den Widerstand schwerer oder leichter. In ERG-Workouts hält der Trainer die Watt, dort
              wirkt das Schalten nicht.
            </span>
          </div>
        </div>

        <div className="grid cols-3">
          <div className="card">
            <h2>Zwift-Schalter</h2>
            <div className="muted small" style={{ marginBottom: 10 }}>
              Zwift Click, Click v2, Play oder Ride: <strong>+</strong> schaltet schwerer, <strong>−</strong> leichter. Zum Koppeln einen Knopf
              drücken, bis die LED blinkt.
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <StatusDot state={shifter.state} label={shifter.name} />
              {connected ? (
                <button onClick={() => void deviceManager.disconnectShifter()}>Trennen</button>
              ) : (
                <button className="primary" disabled={busy} onClick={() => void deviceManager.connectShifter()}>
                  {busy ? 'Verbinde …' : 'Verbinden'}
                </button>
              )}
            </div>
            {shifter.error && (
              <div className="error-text" style={{ marginTop: 8 }}>
                {shifter.error}
              </div>
            )}
          </div>

          <div className="card">
            <h2>Maus</h2>
            <Toggle
              checked={settings.shiftMouse}
              onChange={(v) => updateSettings({ shiftMouse: v })}
              label="Mit der Maus schalten"
              hint="Während der Fahrt: Linksklick schaltet hoch (schwerer), Rechtsklick runter (leichter)."
            />
          </div>

          <div className="card">
            <h2>Tastatur</h2>
            <Toggle
              checked={settings.shiftKeys}
              onChange={(v) => updateSettings({ shiftKeys: v })}
              label="Mit der Tastatur schalten"
              hint={
                <>
                  <kbd>+</kbd> schaltet hoch, <kbd>−</kbd> runter.
                </>
              }
            />
          </div>
        </div>

        <div
          className={`card shift-test${flash ? ` flash-${flash}` : ''}`}
          onMouseDown={(e) => {
            if (!settings.shiftMouse || (e.button !== 0 && e.button !== 2)) return;
            shift(e.button === 0 ? 1 : -1);
          }}
          onContextMenu={(e) => settings.shiftMouse && e.preventDefault()}
        >
          <span className="muted small">Ausprobieren{settings.shiftMouse ? ' – hier klicken, Tasten oder Schalter drücken' : ' – Tasten oder Schalter drücken'}</span>
          <div className="shift-test-gear">
            <small>Gang</small>
            {gear}
          </div>
          <div className="shift-test-bar">
            {GEARS.map((_, i) => (
              <span key={i} className={i < gear ? 'on' : ''} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
