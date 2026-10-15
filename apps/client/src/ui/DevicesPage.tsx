import { useEffect, useState } from 'react';
import { deviceManager, type DeviceSlot } from '../devices/deviceManager';
import { platform } from '../devices/platform';
import { logStore, logText } from '../state/log';
import { settingsStore, updateSettings } from '../state/settings';
import { useStore } from '../state/store';
import { StatusDot, Tile, fmt } from './components';

const SLOT_INFO: Record<DeviceSlot, { title: string; hint: string }> = {
  trainer: { title: 'Smart-Trainer', hint: 'KICKR Core oder jeder FTMS-Trainer' },
  hrm: { title: 'Herzfrequenz', hint: 'Brustgurt oder Uhr im Broadcast-Modus' },
  cadence: { title: 'Kadenzsensor (optional)', hint: 'Genauer als die geschätzte Kadenz des KICKR Core v1' },
};

export function DevicesPage() {
  const settings = useStore(settingsStore);
  const slots = useStore(deviceManager.slots);
  const metrics = useStore(deviceManager.metrics);
  const trainerConnected = slots.trainer.state === 'connected';

  return (
    <div className="page">
      <div className="page-inner">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h1>Geräte</h1>
          <span className="muted small">Plattform: {platform.label}</span>
        </div>

        {platform.bluetoothHint && !settings.useSimulator && <div className="notice">{platform.bluetoothHint}</div>}

        <div className="card row" style={{ justifyContent: 'space-between' }}>
          <div>
            <strong>Simulator statt Bluetooth</strong>
            <div className="muted small">
              Ein virtueller KICKR, der echte FTMS-Bytes spricht – zum Testen ohne Hardware. Steuerung mit <kbd>↑</kbd>
              <kbd>↓</kbd> (Watt), <kbd>←</kbd>
              <kbd>→</kbd> (Kadenz), <kbd>Leertaste</kbd> (Pause). Mit dem Simulator gibt es später keine Taler.
            </div>
          </div>
          <label className="row">
            <input
              type="checkbox"
              checked={settings.useSimulator}
              onChange={(e) => updateSettings({ useSimulator: e.target.checked })}
              disabled={Object.values(slots).some((s) => s.state !== 'disconnected')}
            />
            aktiv
          </label>
        </div>

        <div className="grid cols-3">
          {(Object.keys(SLOT_INFO) as DeviceSlot[]).map((slot) => {
            const s = slots[slot];
            const busy = s.state === 'connecting';
            const connected = s.state === 'connected' || s.state === 'reconnecting';
            return (
              <div className="card" key={slot}>
                <h2>{SLOT_INFO[slot].title}</h2>
                <div className="muted small" style={{ marginBottom: 10 }}>
                  {SLOT_INFO[slot].hint}
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <StatusDot state={s.state} label={s.name ? `${s.name}${s.simulated ? ' (Simulator)' : ''}` : undefined} />
                  {connected ? (
                    <button onClick={() => deviceManager.disconnect(slot)}>Trennen</button>
                  ) : (
                    <button className="primary" disabled={busy || (slot === 'cadence' && settings.useSimulator)} onClick={() => deviceManager.connect(slot)}>
                      {busy ? 'Verbinde …' : 'Verbinden'}
                    </button>
                  )}
                </div>
                {s.error && <div className="error-text" style={{ marginTop: 8 }}>{s.error}</div>}
              </div>
            );
          })}
        </div>

        <div className="grid cols-4">
          <Tile label="Leistung (3 s)" value={fmt(metrics.power3s)} unit="W" sub={`aktuell ${fmt(metrics.power)} W`} />
          <Tile
            label="Kadenz"
            value={fmt(metrics.cadence)}
            unit="rpm"
            sub={metrics.cadenceSource === 'sensor' ? 'vom Kadenzsensor' : metrics.cadenceSource === 'trainer' ? 'vom Trainer (geschätzt)' : 'keine Quelle'}
          />
          <Tile
            label="Herzfrequenz"
            value={fmt(metrics.heartRate)}
            unit="bpm"
            sub={metrics.heartRateSource === 'hrm' ? 'vom Gurt' : metrics.heartRateSource === 'trainer' ? 'über Trainer' : 'keine Quelle'}
          />
          <Tile label="Trainer-Speed" value={fmt(metrics.trainerSpeedKmh, 1)} unit="km/h" sub={metrics.stale ? 'keine Daten' : 'Schwungrad'} />
        </div>

        {trainerConnected && <TrainerTest />}
        {settings.useSimulator && deviceManager.simTransport.trainer?.connected && <SimulatorControls />}
        <Diagnostics />
        <KickrChecklist />
      </div>
    </div>
  );
}

function TrainerTest() {
  const [watts, setWatts] = useState(150);
  const [grade, setGrade] = useState(3);
  const trainer = deviceManager.trainer;
  const [target, setTarget] = useState(trainer?.targetDescription ?? '—');

  return (
    <div className="card">
      <h2>Trainer testen</h2>
      <p className="muted small" style={{ marginTop: -6 }}>
        Protokoll: <strong>{trainer?.protocol.toUpperCase()}</strong> · ERG {deviceManager.canErg ? '✓' : '✗'} · SIM{' '}
        {deviceManager.canSim ? '✓' : '✗'} · aktuelles Ziel: <strong>{target}</strong>
      </p>
      <div className="grid cols-3">
        <div>
          <div className="row">
            <label style={{ width: 120 }}>ERG: {watts} W</label>
            <input type="range" min={50} max={500} step={5} value={watts} onChange={(e) => setWatts(Number(e.target.value))} style={{ flex: 1 }} />
          </div>
          <button
            className="primary"
            style={{ marginTop: 8 }}
            disabled={!deviceManager.canErg}
            onClick={async () => {
              await deviceManager.setErg(watts);
              setTarget(deviceManager.trainer?.targetDescription ?? '—');
            }}
          >
            ERG setzen
          </button>
        </div>
        <div>
          <div className="row">
            <label style={{ width: 120 }}>Steigung: {grade.toFixed(1)} %</label>
            <input type="range" min={-10} max={16} step={0.5} value={grade} onChange={(e) => setGrade(Number(e.target.value))} style={{ flex: 1 }} />
          </div>
          <button
            className="primary"
            style={{ marginTop: 8 }}
            disabled={!deviceManager.canSim}
            onClick={async () => {
              await deviceManager.setSim({ gradePercent: grade, totalWeightKg: settingsStore.get().weightKg + 9 });
              setTarget(deviceManager.trainer?.targetDescription ?? '—');
            }}
          >
            Steigung setzen
          </button>
        </div>
        <div className="muted small">
          ERG: Der Trainer hält die Watt – trete mit verschiedenen Kadenzen, die Leistung sollte gleich bleiben.
          <br />
          SIM: Die Steigung wird hier ungedämpft gesendet (100 %). In der Fahrt gilt die Trainer-Schwierigkeit aus den Einstellungen.
        </div>
      </div>
    </div>
  );
}

function SimulatorControls() {
  const sim = deviceManager.simTransport.trainer!;
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="card">
      <h2>Simulator</h2>
      <div className="grid cols-3">
        <div className="row">
          <label style={{ width: 150 }}>Fahrer-Watt: {sim.rider.power} W</label>
          <input type="range" min={0} max={800} step={5} value={sim.rider.power} onChange={(e) => sim.setRider({ power: Number(e.target.value) })} style={{ flex: 1 }} />
        </div>
        <div className="row">
          <label style={{ width: 150 }}>Kadenz: {sim.rider.cadence} rpm</label>
          <input type="range" min={0} max={130} step={1} value={sim.rider.cadence} onChange={(e) => sim.setRider({ cadence: Number(e.target.value) })} style={{ flex: 1 }} />
        </div>
        <div className="muted small">
          Modus: <strong>{sim.mode.toUpperCase()}</strong>
          {sim.mode === 'erg' && ` · Ziel ${sim.targetPower} W`}
          {sim.mode === 'sim' && ` · Steigung ${sim.gradePercent.toFixed(1)} %`}
          <br />
          Im ERG-Modus bestimmt der Trainer die Watt, die Fahrer-Watt gelten nur in SIM/frei.
        </div>
      </div>
    </div>
  );
}

function Diagnostics() {
  const entries = useStore(logStore);
  const [gatt, setGatt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const trainer = deviceManager.trainer;

  const copy = async () => {
    const text = [trainer?.describe() ?? 'Kein Trainer', gatt ?? '', logText()].join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setGatt(text);
    }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Diagnose</h2>
        <div className="row">
          <button disabled={!trainer} onClick={async () => setGatt(await deviceManager.trainerGattTable())}>
            GATT-Tabelle lesen
          </button>
          <button onClick={copy}>{copied ? 'Kopiert ✓' : 'Alles kopieren'}</button>
        </div>
      </div>
      {trainer && <pre className="block" style={{ marginBottom: 10 }}>{trainer.describe()}</pre>}
      {gatt && <pre className="block" style={{ marginBottom: 10 }}>{gatt}</pre>}
      <div className="log">
        {entries.length === 0 && <span className="muted">Noch keine Einträge.</span>}
        {entries.map((e) => (
          <div key={e.id} className={e.level}>
            {new Date(e.time).toLocaleTimeString()} {e.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function KickrChecklist() {
  return (
    <div className="card">
      <h2>Checkliste KICKR Core v1 (Phase 0)</h2>
      <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
        <li>Firmware über die Wahoo-App aktualisieren, danach die Wahoo-App schließen (sie belegt sonst eine Verbindung).</li>
        <li>„Verbinden“ beim Smart-Trainer – der Core erscheint als „KICKR CORE xxxx“.</li>
        <li>
          Unter Diagnose steht das erkannte Protokoll: <strong>FTMS</strong> (bevorzugt) oder <strong>WAHOO</strong> (Fallback).
        </li>
        <li>„GATT-Tabelle lesen“ und „Alles kopieren“ – den Text an Claude schicken, falls etwas nicht klappt.</li>
        <li>ERG 150 W setzen und mit 70 und 100 rpm treten: Die Leistung muss stabil bei ~150 W bleiben.</li>
        <li>Steigung 0 %, dann 8 % setzen: Der Widerstand muss spürbar zunehmen.</li>
        <li>Kadenz-Anzeige mit gezählten Umdrehungen vergleichen (geschätzte Kadenz des Core).</li>
        <li>Unter Windows: Funktioniert Bluetooth? Wenn nicht, bitte melden (Fallback: ANT+-Stick).</li>
      </ol>
    </div>
  );
}
