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
