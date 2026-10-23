import { referenceFtp } from '../ftp/advisor';
import { useState } from 'react';
import { resolveWorkout, workoutStats, type CadenceTarget, type Workout, type WorkoutStep } from '@velo/workouts';
import { settingsStore } from '../state/settings';
import { useStore } from '../state/store';
import { formatDuration } from './components';
import { WorkoutChart } from './WorkoutChart';

const BLOCKS: Array<{ label: string; make: () => WorkoutStep }> = [
  { label: 'Aufwärmen', make: () => ({ type: 'warmup', durationS: 600, powerStart: 0.5, powerEnd: 0.75 }) },
  { label: 'Konstant', make: () => ({ type: 'steady', durationS: 300, power: 0.75 }) },
  { label: 'Intervalle', make: () => ({ type: 'intervals', repeat: 5, on: { durationS: 60, power: 1.1 }, off: { durationS: 60, power: 0.55 } }) },
  { label: 'Rampe', make: () => ({ type: 'ramp', durationS: 300, powerStart: 0.6, powerEnd: 1.0 }) },
  { label: 'Freie Fahrt', make: () => ({ type: 'freeride', durationS: 300 }) },
  { label: 'Vollgas', make: () => ({ type: 'maxeffort', durationS: 20 }) },
  { label: 'Ausrollen', make: () => ({ type: 'cooldown', durationS: 300, powerStart: 0.6, powerEnd: 0.4 }) },
];

const TYPE_LABEL: Record<WorkoutStep['type'], string> = {
  warmup: 'Aufwärmen',
  cooldown: 'Ausrollen',
  ramp: 'Rampe',
  steady: 'Konstant',
  intervals: 'Intervalle',
  freeride: 'Freie Fahrt',
  maxeffort: 'Vollgas',
};

/** "5" = 5 min, "1:30" = 1 min 30 s, "1:00:00" = 1 h. */
function parseDuration(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const n = parts.map(Number);
  if (n.length === 1) return n[0]! * 60;
  if (n.length === 2) return n[0]! * 60 + n[1]!;
  return n[0]! * 3600 + n[1]! * 60 + n[2]!;
}

function DurationInput({ value, onChange }: { value: number; onChange: (s: number) => void }) {
  const [text, setText] = useState(formatDuration(value));
  return (
    <input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const s = parseDuration(text);
        if (s !== null && s > 0) onChange(s);
        setText(formatDuration(s !== null && s > 0 ? s : value));
      }}
      title="Dauer als Minuten oder m:ss"
      style={{ width: 70 }}
    />
  );
}

function PowerInput({ value, onChange, ftp }: { value: number; onChange: (f: number) => void; ftp: number }) {
  return (
    <span className="row" style={{ gap: 4 }}>
      <input
        type="number"
        min={10}
        max={300}
        step={1}
        value={Math.round(value * 100)}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v > 0) onChange(v / 100);
        }}
        style={{ width: 66 }}
      />
      <span className="muted small">% ({Math.round(value * ftp)} W)</span>
    </span>
  );
}

function CadenceInput({ value, onChange }: { value: CadenceTarget | undefined; onChange: (c: CadenceTarget | undefined) => void }) {
  const display = value === undefined ? '' : typeof value === 'number' ? String(value) : `${value[0]}-${value[1]}`;
  const [text, setText] = useState(display);
  return (
    <input
      value={text}
      placeholder="Kadenz"
      title="Ziel-Kadenz, z. B. 90 oder 85-95 (leer = keine Vorgabe)"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const t = text.trim();
        const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(t);
        if (!t) onChange(undefined);
        else if (range) onChange([Number(range[1]), Number(range[2])]);
        else if (/^\d+$/.test(t)) onChange(Number(t));
        else setText(display);
      }}
      style={{ width: 78 }}
    />
  );
}

function CadenceField(props: { value: CadenceTarget | undefined; onChange: (c: CadenceTarget | undefined) => void }) {
  return (
    <span className="row" style={{ gap: 4 }}>
      <CadenceInput {...props} />
      <span className="muted small">rpm</span>
    </span>
  );
}

/** Block-based workout builder with live preview. */
export function WorkoutEditor({ initial, onSave, onCancel }: { initial: Workout; onSave: (w: Workout) => void; onCancel: () => void }) {
  const ftp = referenceFtp(useStore(settingsStore));
  // Workouts in absolute watts (ramp tests) are edited as FTP fractions.
  const [w, setW] = useState<Workout>(() => resolveWorkout(initial, ftp));
  const stats = workoutStats(w);

  const update = (i: number, step: WorkoutStep) => setW({ ...w, steps: w.steps.map((s, j) => (j === i ? step : s)) });
  const move = (i: number, d: number) => {
    const steps = [...w.steps];
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j]!, steps[i]!];
    setW({ ...w, steps });
  };

  return (
    <div className="modal-backdrop">
      <div className="modal editor">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Workout-Editor</h2>
          <span className="muted small">
            {formatDuration(stats.durationS)} · TSS {Math.round(stats.tss)} · IF {stats.intensityFactor.toFixed(2)} · FTP {ftp} W
          </span>
        </div>
        <div className="form" style={{ margin: '12px 0' }}>
          <label>Name</label>
          <input value={w.name} maxLength={60} onChange={(e) => setW({ ...w, name: e.target.value })} />
          <label>Beschreibung</label>
          <input value={w.description} maxLength={240} onChange={(e) => setW({ ...w, description: e.target.value })} />
        </div>
        <WorkoutChart workout={w} height={90} ftp={ftp} />
        <div className="row" style={{ margin: '10px 0', gap: 6 }}>
          {BLOCKS.map((b) => (
            <button key={b.label} className="chip" onClick={() => setW({ ...w, steps: [...w.steps, b.make()] })}>
              + {b.label}
            </button>
          ))}
        </div>
        <div className="editor-steps">
          {w.steps.map((s, i) => (
            <div key={i} className="editor-step">
              <strong style={{ width: 92 }}>{TYPE_LABEL[s.type]}</strong>
              {s.type === 'intervals' ? (
                <>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={s.repeat}
                    onChange={(e) => update(i, { ...s, repeat: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })}
                    style={{ width: 56 }}
                  />
                  <span className="muted small">×</span>
                  <span className="muted small">an</span>
                  <DurationInput value={s.on.durationS} onChange={(d) => update(i, { ...s, on: { ...s.on, durationS: d } })} />
                  <PowerInput value={s.on.power} ftp={ftp} onChange={(p) => update(i, { ...s, on: { ...s.on, power: p } })} />
                  <CadenceField value={s.on.cadence} onChange={(c) => update(i, { ...s, on: { ...s.on, cadence: c } })} />
                  <span className="muted small">aus</span>
                  <DurationInput value={s.off.durationS} onChange={(d) => update(i, { ...s, off: { ...s.off, durationS: d } })} />
                  <PowerInput value={s.off.power} ftp={ftp} onChange={(p) => update(i, { ...s, off: { ...s.off, power: p } })} />
                </>
              ) : (
                <>
                  <DurationInput value={s.durationS} onChange={(d) => update(i, { ...s, durationS: d })} />
                  {s.type === 'steady' && (
                    <>
                      <PowerInput value={s.power} ftp={ftp} onChange={(p) => update(i, { ...s, power: p })} />
                      <CadenceField value={s.cadence} onChange={(c) => update(i, { ...s, cadence: c })} />
                    </>
                  )}
                  {(s.type === 'warmup' || s.type === 'cooldown' || s.type === 'ramp') && (
                    <>
                      <PowerInput value={s.powerStart} ftp={ftp} onChange={(p) => update(i, { ...s, powerStart: p })} />
                      <span className="muted">→</span>
                      <PowerInput value={s.powerEnd} ftp={ftp} onChange={(p) => update(i, { ...s, powerEnd: p })} />
                    </>
                  )}
                  {s.type === 'freeride' && <span className="muted small">SIM-Modus, Leistung frei</span>}
                  {s.type === 'maxeffort' && <span className="muted small">alles geben (SIM-Modus)</span>}
                </>
              )}
              <span className="spacer" />
              <button className="icon" title="nach oben" onClick={() => move(i, -1)} disabled={i === 0}>
                ↑
              </button>
              <button className="icon" title="nach unten" onClick={() => move(i, 1)} disabled={i === w.steps.length - 1}>
                ↓
              </button>
              <button className="icon" title="duplizieren" onClick={() => setW({ ...w, steps: [...w.steps.slice(0, i + 1), structuredClone(s), ...w.steps.slice(i + 1)] })}>
                ⧉
              </button>
              <button className="icon danger" title="löschen" onClick={() => setW({ ...w, steps: w.steps.filter((_, j) => j !== i) })}>
                ✕
              </button>
            </div>
          ))}
          {w.steps.length === 0 && <div className="muted">Füge oben Blöcke hinzu.</div>}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button onClick={onCancel}>Abbrechen</button>
          <button className="primary" disabled={w.steps.length === 0 || !w.name.trim()} onClick={() => onSave({ ...w, name: w.name.trim() })}>
            Speichern
          </button>
        </div>
      </div>
    </div>
  );
}
